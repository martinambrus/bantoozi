import {
  AdminSettingsWriteSchema,
  type AdminSettingKey,
  type RuntimeSettingKey,
} from '@bantoozi/shared';
import type { TFunction } from 'i18next';

import { describeIssues } from './settings-validation.js';

/** The live runtime keys of Settings (M8b-T10), by the group they are shown in. */
export const RUNTIME_GROUPS: readonly {
  id: 'engine' | 'ollama' | 'ingestion' | 'api' | 'translation';
  keys: readonly RuntimeSettingKey[];
}[] = [
  {
    id: 'engine',
    keys: [
      'engine.typesafe_model',
      'engine.typesafe_base_url',
      'engine.typesafe_price_per_mtok_usd',
      'engine.concurrency',
      'engine.prefilter_min_cards',
      'engine.auto_analysis_daily_cap',
    ],
  },
  {
    id: 'ollama',
    keys: [
      'engine.llm_fallback_enabled',
      'engine.ollama_models',
      'engine.ollama_base_url',
      'engine.ollama_max_concurrency',
    ],
  },
  { id: 'ingestion', keys: ['ingest.max_age_days', 'fetch.limits'] },
  { id: 'api', keys: ['api.rate_limits_enabled'] },
  { id: 'translation', keys: ['translate.libretranslate_url'] },
];

/** The Jev release has its own editor, which proves a change with a probe first. */
export const MODEL_KEY = 'engine.typesafe_model';

/** Changing these re-enriches and re-matches the corpus: an acknowledgement comes first. */
export const ACKNOWLEDGED_KEYS: readonly AdminSettingKey[] = [
  'engine.llm_fallback_enabled',
  'engine.ollama_models',
];

export type FieldKind = 'integer' | 'decimal' | 'text' | 'switch' | 'megabytes';
export interface FieldSpec {
  /** The part of a compound value (its label is `<key>.<part>`); null for a plain value. */
  part: string | null;
  kind: FieldKind;
}

const plain = (kind: FieldKind): FieldSpec[] => [{ part: null, kind }];

export const FIELDS: Record<RuntimeSettingKey, FieldSpec[]> = {
  'engine.typesafe_model': plain('text'),
  'engine.typesafe_base_url': plain('text'),
  'engine.typesafe_price_per_mtok_usd': plain('decimal'),
  'engine.concurrency': plain('integer'),
  'engine.llm_fallback_enabled': plain('switch'),
  'engine.ollama_models': [
    { part: 'fast', kind: 'text' },
    { part: 'strong', kind: 'text' },
  ],
  'engine.ollama_base_url': plain('text'),
  'engine.ollama_max_concurrency': plain('integer'),
  'engine.prefilter_min_cards': plain('integer'),
  'engine.auto_analysis_daily_cap': plain('integer'),
  'ingest.max_age_days': plain('integer'),
  'fetch.limits': [
    { part: 'timeoutMs', kind: 'integer' },
    { part: 'maxBytes', kind: 'megabytes' },
  ],
  'api.rate_limits_enabled': plain('switch'),
  'translate.libretranslate_url': plain('text'),
};

const MB = 1024 * 1024;

/** The text of each field of a draft, by part (`''` for a plain value). */
export type Draft = Record<string, string>;
const partId = (field: FieldSpec) => field.part ?? '';

function textOf(kind: FieldKind, value: unknown): string {
  // A switch is tri-state: an unknown value (null: no process can tell its default) is `''`, distinct
  // from an explicit `false`.
  if (kind === 'switch') {
    if (value === null || value === undefined) return '';
    return value === true ? 'true' : 'false';
  }
  if (value === null || value === undefined) return '';
  if (kind === 'megabytes') return typeof value === 'number' ? String(value / MB) : '';
  return String(value);
}

/** The draft that shows a value (stored, else default); an unknown value shows empty fields. */
export function draftOf(key: RuntimeSettingKey, value: unknown): Draft {
  const draft: Draft = {};
  for (const field of FIELDS[key]) {
    const source =
      field.part === null
        ? value
        : typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)[field.part]
          : undefined;
    draft[partId(field)] = textOf(field.kind, source);
  }
  return draft;
}

function fieldValue(field: FieldSpec, text: string): unknown {
  switch (field.kind) {
    case 'switch':
      return text === 'true';
    case 'text':
      return text;
    case 'megabytes':
      return text.trim() === '' ? Number.NaN : Math.round(Number(text) * MB);
    default:
      return text.trim() === '' ? Number.NaN : Number(text);
  }
}

export type RuntimeCheck = { ok: true; value: unknown } | { ok: false; reason: string };

/** What the shared schema of the key says about a draft, before any request. */
export function checkDraft(key: RuntimeSettingKey, draft: Draft): RuntimeCheck {
  const fields = FIELDS[key];
  const value =
    fields[0]?.part === null
      ? fieldValue(fields[0], draft[''] ?? '')
      : Object.fromEntries(
          fields.map((field) => [field.part, fieldValue(field, draft[partId(field)] ?? '')]),
        );
  const result = AdminSettingsWriteSchema.shape[key].safeParse(value);
  if (!result.success) return { ok: false, reason: describeIssues(result.error.issues) };
  return { ok: true, value: result.data };
}

export const sameDraft = (a: Draft, b: Draft): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

/** A value as a person reads it ("Default: …"). */
export function formatValue(t: TFunction, key: RuntimeSettingKey, value: unknown): string {
  if (value === null || value === undefined) return t('settings.defaultUnknown');
  if (typeof value === 'boolean') return t(value ? 'settings.on' : 'settings.off');
  if (key === 'engine.ollama_models' && typeof value === 'object') {
    const { fast, strong } = value as { fast: unknown; strong: unknown };
    return t('settings.models', { fast: String(fast), strong: String(strong) });
  }
  if (key === 'fetch.limits' && typeof value === 'object') {
    const { timeoutMs, maxBytes } = value as { timeoutMs: number; maxBytes: number };
    return t('settings.limits', { timeoutMs, megabytes: maxBytes / MB });
  }
  return String(value);
}

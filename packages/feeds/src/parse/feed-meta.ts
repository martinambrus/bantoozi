import { normalizeLanguageHint } from '@bantoozi/shared/server';

import { PARSE_LIMITS } from './limits.js';
import { cleanRawTitle, type RawTitle } from './normalize-item.js';
import { htmlToText } from './sanitize.js';
import { cleanText, truncateChars } from './text.js';
import type { FeedMeta } from './types.js';
import { resolveHttpUrl } from './urls.js';

/** Maximum plain-text feed description length. */
const DESCRIPTION_CHARS = 2_000;

const SY_PERIODS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'yearly']);

/** Raw feed-level values mapped from a feed document. */
export interface RawFeedMeta {
  title: RawTitle | null;
  siteUrl: { href: string; base: string } | null;
  description: RawTitle | null;
  language: string | null;
  icons: { href: string; base: string }[];
  ttl: string | null;
  syUpdatePeriod: string | null;
  syUpdateFrequency: string | null;
}

function positiveInteger(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return number > 0 ? number : null;
}

function nonEmpty(value: string): string | null {
  return value === '' ? null : value;
}

/** Applies the feed-level rules of spec 03 §6 (title, site URL, description, language → hint). */
export function normalizeFeedMeta(raw: RawFeedMeta): FeedMeta {
  const title = truncateChars(cleanRawTitle(raw.title), PARSE_LIMITS.titleChars).trim();
  const description =
    raw.description === null
      ? ''
      : truncateChars(
          raw.description.type === 'html'
            ? cleanText(htmlToText(raw.description.value))
            : cleanText(raw.description.value),
          DESCRIPTION_CHARS,
        ).trim();
  const language = raw.language === null ? '' : truncateChars(cleanText(raw.language), 64);
  let iconUrl: string | null = null;
  for (const icon of raw.icons) {
    iconUrl = resolveHttpUrl(icon.href, icon.base);
    if (iconUrl !== null) break;
  }
  const period = raw.syUpdatePeriod === null ? '' : raw.syUpdatePeriod.trim().toLowerCase();
  return {
    title: nonEmpty(title),
    siteUrl: raw.siteUrl === null ? null : resolveHttpUrl(raw.siteUrl.href, raw.siteUrl.base),
    description: nonEmpty(description),
    language: nonEmpty(language),
    langHint: normalizeLanguageHint(language) ?? null,
    iconUrl,
    ttlMinutes: positiveInteger(raw.ttl),
    syUpdatePeriod: SY_PERIODS.has(period) ? period : null,
    syUpdateFrequency: positiveInteger(raw.syUpdateFrequency),
  };
}

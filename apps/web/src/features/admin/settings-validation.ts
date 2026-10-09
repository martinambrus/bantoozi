import {
  AdminSettingsValuesSchema,
  mergeRankerConfig,
  type AdminSettingKey,
} from '@bantoozi/shared';

export type SettingCheck =
  | { ok: true; value: unknown }
  | { ok: false; problem: 'json' }
  | { ok: false; problem: 'schema' | 'ranker'; reason: string };

interface Issue {
  path: readonly PropertyKey[];
  message: string;
}

function issuesOf(error: unknown): readonly Issue[] | null {
  if (typeof error !== 'object' || error === null || !('issues' in error)) return null;
  return Array.isArray(error.issues) ? (error.issues as Issue[]) : null;
}

/** The first few problems of a rejected value, each with the place it is found at. */
function describeIssues(issues: readonly Issue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join('.')}: ${issue.message}`,
    )
    .join('; ');
}

/**
 * What the server would decide about this text, before any request: it must be JSON, pass the
 * schema of its key and, for `ranker.thresholds`, merge onto the defaults into a valid config.
 */
export function checkSetting(key: AdminSettingKey, text: string): SettingCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'json' };
  }
  const result = AdminSettingsValuesSchema.shape[key].safeParse(parsed);
  if (!result.success) {
    return { ok: false, problem: 'schema', reason: describeIssues(result.error.issues) };
  }
  if (key === 'ranker.thresholds') {
    try {
      mergeRankerConfig(result.data);
    } catch (error) {
      const issues = issuesOf(error);
      if (issues === null) throw error;
      return { ok: false, problem: 'ranker', reason: describeIssues(issues) };
    }
  }
  return { ok: true, value: result.data };
}

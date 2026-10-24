/** Internal revision carried across stale replacements; payload schemas remain unchanged. */
export function parseStaleRecoveryRevision(
  value: unknown,
): { originalJobId: string; hop: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^stale:(.+):(\d+)$/.exec(value);
  if (match === null) return null;
  const hop = Number(match[2]);
  return Number.isSafeInteger(hop) && hop < Number.MAX_SAFE_INTEGER
    ? { originalJobId: match[1]!, hop }
    : null;
}

/** Only stale recovery revisions need to travel from the outbox to the broker. */
export function staleRecoveryRevisionOf(dedupeKey: string | null): string | undefined {
  if (dedupeKey === null) return undefined;
  try {
    const revision: unknown = (JSON.parse(dedupeKey) as { revision?: unknown } | null)?.revision;
    return parseStaleRecoveryRevision(revision) === null ? undefined : (revision as string);
  } catch {
    return undefined;
  }
}

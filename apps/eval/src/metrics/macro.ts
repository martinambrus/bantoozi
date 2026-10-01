/**
 * Hierarchical macro averages (spec 10 §4): supported contexts are averaged within each actual
 * participant with equal context weights, then participants are weighted equally. Unsupported
 * (null) cells are left out, never counted as 0 or 0.5; a participant without a supported context
 * drops out, and the macro is null when nobody remains.
 */
export interface MacroCell {
  participantKey: string;
  contextId: string;
  value: number | null;
}

export interface MacroAverage {
  value: number | null;
  participants: number;
  contexts: number;
  /** Per participant: the mean of its supported contexts. */
  byParticipant: Map<string, number>;
}

export function participantMacro(cells: readonly MacroCell[]): MacroAverage {
  const grouped = new Map<string, number[]>();
  let contexts = 0;
  for (const cell of cells) {
    if (cell.value === null) continue;
    const list = grouped.get(cell.participantKey) ?? [];
    list.push(cell.value);
    grouped.set(cell.participantKey, list);
    contexts += 1;
  }
  const byParticipant = new Map<string, number>();
  for (const [key, values] of [...grouped].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    byParticipant.set(key, values.reduce((a, b) => a + b, 0) / values.length);
  }
  const means = [...byParticipant.values()];
  return {
    value: means.length === 0 ? null : means.reduce((a, b) => a + b, 0) / means.length,
    participants: means.length,
    contexts,
    byParticipant,
  };
}

/**
 * Item weights for pooling (spec 10 §5 step 4): every participant gets equal total weight, split
 * equally among its contexts, then equally among each context's items, so persona count cannot
 * give one human extra weight. Weights sum to the number of participants.
 */
export function hierarchicalWeights<T extends { participantKey: string; contextId: string }>(
  items: readonly T[],
): number[] {
  const contextsOf = new Map<string, Set<string>>();
  const itemsOf = new Map<string, number>();
  for (const item of items) {
    const set = contextsOf.get(item.participantKey) ?? new Set<string>();
    set.add(item.contextId);
    contextsOf.set(item.participantKey, set);
    const key = `${item.participantKey}\u0000${item.contextId}`;
    itemsOf.set(key, (itemsOf.get(key) ?? 0) + 1);
  }
  return items.map((item) => {
    const contexts = contextsOf.get(item.participantKey)?.size ?? 1;
    const n = itemsOf.get(`${item.participantKey}\u0000${item.contextId}`) ?? 1;
    return 1 / contexts / n;
  });
}

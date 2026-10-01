import {
  groupBootstrap,
  pairedGroupBootstrap,
  participantMacro,
  precisionAtK,
  rocAuc,
  type BootstrapInterval,
  type GroupWeights,
  type MacroAverage,
  type PrecisionAtK,
} from '../metrics/index.js';
import type { RatedItem } from './items.js';

/**
 * Ranking metrics over rated items (spec 10 §4 "Ranking"): AUC per cell (a reading context, or a
 * context × language), hierarchical macro averages, paired story-group bootstrap intervals and
 * P@k. A cell is supported when it has ≥20 rated items and ≥5 of each class (spec 10 §5); support
 * depends only on the labels, so every scorer is compared on the same cells. Unknown scores are left
 * out of the primary AUC and counted; the missing-output sensitivity puts unknown liked items below
 * and unknown disliked items above every scored item (spec 10 §3 "Completeness").
 */
export const AUC_MIN_ITEMS = 20;
export const AUC_MIN_PER_CLASS = 5;
export const DEFAULT_RESAMPLES = 1000;

export type ScoreFn = (item: RatedItem) => number | null;
export type CellLevel = 'context' | 'context-lang';

export interface Cell {
  id: string;
  participantKey: string;
  contextId: string;
  lang: string | null;
  items: RatedItem[];
  likes: number;
  dislikes: number;
  supported: boolean;
}

export function isSupported(likes: number, dislikes: number): boolean {
  return (
    likes + dislikes >= AUC_MIN_ITEMS && likes >= AUC_MIN_PER_CLASS && dislikes >= AUC_MIN_PER_CLASS
  );
}

export function buildCells(items: readonly RatedItem[], level: CellLevel): Cell[] {
  const cells = new Map<string, Cell>();
  for (const item of items) {
    const lang = level === 'context' ? null : item.lang;
    const id = lang === null ? item.contextId : `${item.contextId}/${lang}`;
    let cell = cells.get(id);
    if (cell === undefined) {
      cell = {
        id,
        participantKey: item.participantKey,
        contextId: item.contextId,
        lang,
        items: [],
        likes: 0,
        dislikes: 0,
        supported: false,
      };
      cells.set(id, cell);
    }
    cell.items.push(item);
    if (item.liked) cell.likes += 1;
    else cell.dislikes += 1;
  }
  const list = [...cells.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const cell of list) cell.supported = isSupported(cell.likes, cell.dislikes);
  return list;
}

/** AUC of a cell's scored items under group multiplicities (all 1 without `weights`). */
export function itemsAuc(
  items: readonly RatedItem[],
  score: ScoreFn,
  weights?: GroupWeights,
): number | null {
  const scored = [];
  for (const item of items) {
    const s = score(item);
    if (s === null) continue;
    const weight = weights === undefined ? 1 : (weights.get(item.groupId) ?? 0);
    if (weight > 0) scored.push({ score: s, positive: item.liked, weight });
  }
  return rocAuc(scored);
}

/** The AUC with unknown liked items ranked last and unknown disliked items ranked first. */
export function sensitivityAuc(items: readonly RatedItem[], score: ScoreFn): number | null {
  const known = items.map(score).filter((s): s is number => s !== null);
  const lo = known.length === 0 ? 0 : Math.min(...known) - 1;
  const hi = known.length === 0 ? 1 : Math.max(...known) + 1;
  return rocAuc(
    items.map((item) => {
      const s = score(item);
      return { score: s ?? (item.liked ? lo : hi), positive: item.liked };
    }),
  );
}

export function cellAuc(cell: Cell, score: ScoreFn, weights?: GroupWeights): number | null {
  return cell.supported ? itemsAuc(cell.items, score, weights) : null;
}

/** Hierarchical macro over supported cells (contexts within participants, then participants). */
export function macroAuc(
  cells: readonly Cell[],
  score: ScoreFn,
  weights?: GroupWeights,
): MacroAverage {
  return participantMacro(
    cells.map((cell) => ({
      participantKey: cell.participantKey,
      contextId: cell.id,
      value: cellAuc(cell, score, weights),
    })),
  );
}

export interface BootstrapSettings {
  seed: string;
  resamples?: number;
}

function groupsOf(cells: readonly Cell[]): string[] {
  return cells.flatMap((cell) => cell.items.map((item) => item.groupId));
}

/** Macro AUC with its story-group bootstrap interval (groups move together across contexts). */
export function macroAucWithCi(
  cells: readonly Cell[],
  score: ScoreFn,
  settings: BootstrapSettings,
): { macro: MacroAverage; ci: BootstrapInterval } {
  const macro = macroAuc(cells, score);
  const ci = groupBootstrap(groupsOf(cells), (w) => macroAuc(cells, score, w).value, {
    seed: settings.seed,
    resamples: settings.resamples ?? DEFAULT_RESAMPLES,
  });
  return { macro, ci };
}

/** Paired ΔAUC (candidate − baseline) of the macro on the same resampled groups. */
export function pairedMacroDelta(
  cells: readonly Cell[],
  candidate: ScoreFn,
  baseline: ScoreFn,
  settings: BootstrapSettings,
): BootstrapInterval {
  return pairedGroupBootstrap(
    groupsOf(cells),
    (w) => macroAuc(cells, candidate, w).value,
    (w) => macroAuc(cells, baseline, w).value,
    { seed: settings.seed, resamples: settings.resamples ?? DEFAULT_RESAMPLES },
  );
}

/** One cell's AUC with its interval; the interval is null for an unsupported cell. */
export function cellAucWithCi(
  cell: Cell,
  score: ScoreFn,
  settings: BootstrapSettings,
): { auc: number | null; ci: BootstrapInterval | null } {
  if (!cell.supported) return { auc: null, ci: null };
  const ci = groupBootstrap(
    cell.items.map((item) => item.groupId),
    (w) => itemsAuc(cell.items, score, w),
    { seed: `${settings.seed}:${cell.id}`, resamples: settings.resamples ?? DEFAULT_RESAMPLES },
  );
  return { auc: ci.estimate, ci };
}

/** P@k of a cell over its items with a known score. */
export function cellPrecisionAtK(cell: Cell, score: ScoreFn, k: number): PrecisionAtK {
  const ranked = [];
  for (const item of cell.items) {
    const s = score(item);
    if (s === null) continue;
    ranked.push({
      id: item.articleId,
      score: s,
      positive: item.liked,
      firstSeenAt: item.firstSeenAt,
    });
  }
  return precisionAtK(ranked, k);
}

export function unknownCount(items: readonly RatedItem[], score: ScoreFn): number {
  return items.filter((item) => score(item) === null).length;
}

/**
 * Win count (spec 10 §4): actual participants whose AUC (mean of their supported contexts) beats
 * the baseline's; participants unsupported under either scorer are not counted as wins.
 */
export function participantWins(
  cells: readonly Cell[],
  candidate: ScoreFn,
  baseline: ScoreFn,
): {
  wins: number;
  participants: number;
  byParticipant: Map<string, { candidate: number; baseline: number | null }>;
} {
  const a = macroAuc(cells, candidate).byParticipant;
  const b = macroAuc(cells, baseline).byParticipant;
  const byParticipant = new Map<string, { candidate: number; baseline: number | null }>();
  let wins = 0;
  for (const [key, value] of a) {
    const base = b.get(key) ?? null;
    byParticipant.set(key, { candidate: value, baseline: base });
    if (base !== null && value > base) wins += 1;
  }
  return { wins, participants: a.size, byParticipant };
}

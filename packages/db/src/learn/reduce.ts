import type {
  FeatureSnapshotV1,
  LearnAnalysisResult,
  LearnEvent,
  LearnReaderState,
  LearnSample,
} from './types.js';

const DWELL_MS = 30_000;
const BOUNCE_MS = 5_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const big = (id: string): bigint => BigInt(id);

function consent(event: LearnEvent, flag: 'implicitFeedback' | 'implicitNegative'): boolean {
  const c = event.value.learningConsent;
  return isRecord(c) && c[flag] === true;
}

function featuresOf(event: LearnEvent): FeatureSnapshotV1 | null {
  const f = event.value.features;
  return isRecord(f) ? (f as unknown as FeatureSnapshotV1) : null;
}

function latest(events: LearnEvent[]): LearnEvent | undefined {
  let best: LearnEvent | undefined;
  for (const e of events) if (best === undefined || big(e.id) > big(best.id)) best = e;
  return best;
}

function complete(
  features: FeatureSnapshotV1,
  result: LearnAnalysisResult | undefined,
): FeatureSnapshotV1 {
  if (result === undefined) return features;
  const copy = structuredClone(features);
  for (const card of copy.cards) {
    const p = result.cardP.get(String(card.id));
    if (card.p === null && p !== undefined) {
      card.p = p;
      card.engine = 'typesafe';
    }
  }
  if (copy.values.facets === null && result.facets !== null) {
    copy.values.facets = result.facets;
    copy.values.facetsEngine = 'typesafe';
  }
  return copy;
}

export interface ReduceInput {
  articleId: string;
  state: LearnReaderState;
  /** The article's events of the reduced kinds, any order. */
  events: LearnEvent[];
  /** The user's current `implicitFeedback` / `implicitNegative` preferences. */
  prefs: { implicitFeedback: boolean; implicitNegative: boolean };
  /** Completed analysis results by request id, validated to belong to the user. */
  analysis: Map<string, LearnAnalysisResult>;
}

/**
 * Reduces one article to its effective sample (spec 06 §8.2): rating, else bookmark, else the best
 * surviving implicit signal (dwell, bounce, explicit read); `null` when none survives.
 */
export function reduceArticle(input: ReduceInput): LearnSample | null {
  const { articleId, state, events, prefs } = input;
  const make = (
    event: LearnEvent,
    signal: LearnSample['signal'],
    y: 0 | 1,
    weight: number,
    explicit: boolean,
    features: FeatureSnapshotV1 | null,
  ): LearnSample => ({
    articleId,
    eventId: event.id,
    signal,
    y,
    weight,
    explicit,
    feedbackAt: event.createdAt,
    groupId: features?.values.clusterId ?? articleId,
    features,
  });

  const ratings = events.filter((e) => e.kind === 'rate' || e.kind === 'prompt_answer');
  if (state.rating !== null && state.ratedAt !== null) {
    const effective = latest(
      ratings.filter(
        (e) =>
          e.value.rating === state.rating && e.createdAt.getTime() === state.ratedAt!.getTime(),
      ),
    );
    if (effective !== undefined) {
      let source: LearnEvent | undefined = effective;
      if (featuresOf(effective) === null) {
        source = latest(
          ratings.filter(
            (e) =>
              big(e.id) < big(effective.id) &&
              e.value.contentRevision === effective.value.contentRevision &&
              featuresOf(e) !== null,
          ),
        );
      }
      let features = source === undefined ? null : featuresOf(source);
      if (source !== undefined && features !== null) {
        const requestId = source.value.analysisRequestId;
        const result = typeof requestId === 'string' ? input.analysis.get(requestId) : undefined;
        if (result !== undefined && result.inputSha === source.value.inputSha) {
          features = complete(features, result);
        }
      }
      return make(effective, 'rating', state.rating === 1 ? 1 : 0, 1, true, features);
    }
  }

  if (state.bookmarkedAt !== null) {
    const bookmark = latest(events.filter((e) => e.kind === 'bookmark'));
    if (bookmark !== undefined)
      return make(bookmark, 'bookmark', 1, 0.8, false, featuresOf(bookmark));
  }

  if (!prefs.implicitFeedback) return null;
  const unrate = latest(events.filter((e) => e.kind === 'unrate'));
  const floor = unrate === undefined ? 0n : big(unrate.id);
  const opens = events.filter((e) => e.kind === 'open');

  const sessions = new Map<string, LearnEvent[]>();
  for (const e of events) {
    if (e.kind !== 'dwell' || big(e.id) <= floor || !consent(e, 'implicitFeedback')) continue;
    const opened = e.value.openedAt;
    if (typeof opened !== 'string' || typeof e.value.ms !== 'number') continue;
    const list = sessions.get(opened) ?? [];
    list.push(e);
    sessions.set(opened, list);
  }
  const lastId = (list: LearnEvent[]): bigint => big(latest(list)!.id);
  const ms = (e: LearnEvent): number => e.value.ms as number;
  const sessionFeatures = (opened: string, report: LearnEvent): FeatureSnapshotV1 | null => {
    const at = Date.parse(opened);
    const open = latest(
      opens.filter((o) => o.createdAt.getTime() === at && featuresOf(o) !== null),
    );
    return open === undefined ? featuresOf(report) : featuresOf(open);
  };
  const pick = (
    qualifies: (list: LearnEvent[]) => LearnEvent | undefined,
  ): { opened: string; report: LearnEvent } | null => {
    let best: { opened: string; report: LearnEvent; last: bigint } | null = null;
    for (const [opened, list] of sessions) {
      const report = qualifies(list);
      if (report === undefined) continue;
      const last = lastId(list);
      if (best === null || last > best.last) best = { opened, report, last };
    }
    return best;
  };

  const dwell = pick((list) => latest(list.filter((e) => ms(e) >= DWELL_MS)));
  if (dwell !== null) {
    return make(dwell.report, 'dwell', 1, 0.3, false, sessionFeatures(dwell.opened, dwell.report));
  }
  const bounce = pick((list) => (list.every((e) => ms(e) < BOUNCE_MS) ? latest(list) : undefined));
  if (bounce !== null) {
    return make(
      bounce.report,
      'bounce',
      0,
      0.2,
      false,
      sessionFeatures(bounce.opened, bounce.report),
    );
  }

  if (prefs.implicitNegative && state.readAt !== null) {
    const read = latest(events.filter((e) => e.kind === 'read' && big(e.id) > floor));
    if (
      read !== undefined &&
      read.value.signalOrigin === 'explicit' &&
      consent(read, 'implicitFeedback') &&
      consent(read, 'implicitNegative') &&
      !opens.some((o) => big(o.id) < big(read.id))
    ) {
      return make(read, 'read', 0, 0.1, false, featuresOf(read));
    }
  }
  return null;
}

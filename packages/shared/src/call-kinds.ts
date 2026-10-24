import type { CallKind, InferenceAuthorization } from './ports.js';

/**
 * How each `engine_calls.kind` is treated (spec 02 §3.1, spec 04 §1.1 and §6, spec 10 §7, spec 11
 * §6.1). This table is the one place that classifies call kinds: the engine store (kind check,
 * call-cap groups, authorization pairing), the engine's spend guard, the alert queries, the admin
 * overview and the live engine metrics all derive from it. It is typed over every {@link CallKind},
 * so a new kind does not compile until it is classified here. The one list kept by hand is
 * `engine_calls_kind_check` (a migration owns it); a test compares it with {@link CALL_KINDS}.
 */
export interface CallKindProfile {
  /**
   * Classification work. These kinds share an engine's daily call cap (spec 04 §6) and are the only
   * calls the engine alerts count (spec 11 §6.1, D-272).
   */
  decision: boolean;
  /**
   * Production traffic, counted by the live engine metrics (spec 10 §7): work a reader, a feed or an
   * administrator really caused, billed under the daily budget. Evaluation and synthetic probes are
   * not live (D-198, D-273). Rows of the `libretranslate` engine are left out by engine, whatever
   * their kind.
   */
  live: boolean;
  /**
   * The authorization type that admits this kind and no other kind: the store refuses the kind under
   * any other type, and the type for any other kind (spec 04 §1.1).
   */
  authorization?: InferenceAuthorization['type'];
}

export const CALL_KIND_PROFILES: Readonly<Record<CallKind, CallKindProfile>> = {
  enrich: { decision: true, live: true },
  match: { decision: true, live: true },
  cluster: { decision: true, live: true },
  suggest: { decision: true, live: true },
  /** Tier-2 (LLM) translation. LibreTranslate calls are `translate` too, and not live by engine. */
  translate: { decision: false, live: true },
  /** Evaluation spend: exempt from the production budget, admitted only by an eval router (D-64). */
  eval: { decision: false, live: false, authorization: 'eval' },
  /** Key validation: synthetic, fails on purpose, bound to its validation lease (D-63, D-90). */
  credential_probe: { decision: false, live: false, authorization: 'credential_probe' },
  /** A person's own request for a card draft, billed under the daily budget; the pending draft is its demand (D-240). */
  card_draft: { decision: false, live: true, authorization: 'card_draft' },
  /** One synthetic request about a model id: no reader data and no demand (D-273). */
  model_probe: { decision: false, live: false, authorization: 'model_probe' },
};

/** Every call kind, in table order. */
export const CALL_KINDS: readonly CallKind[] = Object.keys(CALL_KIND_PROFILES) as CallKind[];

const kindsWhere = (test: (profile: CallKindProfile) => boolean): readonly CallKind[] =>
  CALL_KINDS.filter((kind) => test(CALL_KIND_PROFILES[kind]));

/** The classification kinds: enrich, match, cluster and suggest. */
export const DECISION_KINDS: readonly CallKind[] = kindsWhere((profile) => profile.decision);

/** The kinds the live engine metrics leave out: evaluation and the synthetic probes. */
export const NON_LIVE_KINDS: readonly CallKind[] = kindsWhere((profile) => !profile.live);

/** Each kind that has an authorization type of its own, with that type. */
export const KIND_AUTHORIZATIONS: ReadonlyArray<
  readonly [CallKind, InferenceAuthorization['type']]
> = CALL_KINDS.flatMap((kind) => {
  const type = CALL_KIND_PROFILES[kind].authorization;
  return type === undefined ? [] : [[kind, type] as const];
});

/**
 * Whether a call `kind` and the authorization `type` it is reserved under belong together: a kind
 * with an authorization type of its own needs it, and such a type admits no other kind.
 */
export function kindMatchesAuthorization(
  kind: CallKind,
  type: InferenceAuthorization['type'],
): boolean {
  return KIND_AUTHORIZATIONS.every(
    ([ownKind, ownType]) => (kind === ownKind) === (type === ownType),
  );
}

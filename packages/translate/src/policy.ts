/**
 * Version of the translation policy: the tier-2 system prompt, request options and output
 * validation (spec 07 §3) and the quality heuristics (spec 07 §4). The handler stores it in each
 * `ollama` row's `quality_detail` (spec 07 §3). Bump it with any change to those rules; it is
 * provenance, not part of a row's validity, so a bump applies to new translations only.
 */
export const TRANSLATION_POLICY_VERSION = 'translate-policy-1';

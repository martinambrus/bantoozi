/**
 * Jev model ids (docs/design/visible-learning.md §4.1). Every validator of a model id reads these
 * predicates, so an id one place accepts is an id the next place can use. A leaf module: no imports.
 */

/** The alias that follows the newest Jev release; the only alias accepted anywhere. */
export const JEV_LATEST_ALIAS = 'jev-latest';

/** The detail of a failed attempt whose model the provider reports as unknown or retired. */
export const MODEL_UNAVAILABLE_DETAIL = 'model_unavailable';

/**
 * Whether a failed attempt's detail says the provider no longer serves the model, as the bare code
 * (`model_unavailable`), with a status (`model_unavailable:http_404`) or inside an outcome detail
 * (`typesafe:error:model_unavailable:http_404`). The hook for the re-resolution trigger (JEV-3).
 */
export function isModelUnavailableDetail(detail: string | undefined): boolean {
  return detail !== undefined && /(?:^|:)model_unavailable(?::|$)/.test(detail);
}

/** The shape of any model id the app stores, probes or puts in a job payload. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** Exactly `jev-latest`: case-sensitive, no trimming. */
export function isModelAlias(model: string): boolean {
  return model === JEV_LATEST_ALIAS;
}

// A lowercase vendor prefix whose `-` segments start with a letter (so it ends exactly where the version
// starts, without backtracking), `<major>.<minor>.<patch>` and an optional suffix (`-rc1`).
const PINNED_MODEL = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/;
const CONCRETE_JEV_MODEL = /^jev-\d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/;

/** A pinned release id of any vendor prefix: what `TYPESAFE_MODEL` and the engine accept in production. */
export function isPinnedModel(model: string): boolean {
  return PINNED_MODEL.test(model);
}

/** A concrete Jev release (`jev-1.13.0`, `jev-1.14.0-rc1`): the only thing an alias can resolve to. */
export function isConcreteJevModel(model: string): boolean {
  return CONCRETE_JEV_MODEL.test(model);
}

/** The upgrade family of a model id: `jev-<major>` for a concrete Jev release, any other id is its own family. */
export function modelFamily(model: string): string {
  return isConcreteJevModel(model) ? model.slice(0, model.indexOf('.')) : model;
}

/** Whether two model ids share an upgrade family: equal ids, or two concrete Jev releases of one major. */
export function sameModelFamily(a: string, b: string): boolean {
  return (
    a === b || (isConcreteJevModel(a) && isConcreteJevModel(b) && modelFamily(a) === modelFamily(b))
  );
}

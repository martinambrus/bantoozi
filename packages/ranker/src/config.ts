import type { RankerConfig } from '@bantoozi/shared';

/**
 * `RankerConfig` (spec 06 §11) is defined in `@bantoozi/shared`, so the API and the settings
 * registry can validate it without a shared→ranker cycle. The ranker re-exports the schema, the
 * defaults and the fixed window, so its callers need one import.
 */
export {
  DEFAULT_RANKER_CONFIG,
  RANK_WINDOW_DAYS,
  RankerConfigSchema,
  RankerThresholdsSchema,
  mergeRankerConfig,
} from '@bantoozi/shared';
export type { RankerConfig, RankerThresholds } from '@bantoozi/shared';

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/**
 * The config the ranker reads: a validated {@link RankerConfig} (`mergeRankerConfig`) or the
 * `as const` `DEFAULT_RANKER_CONFIG` itself. The functions trust it to be validated (spec 06 §11)
 * and each takes only the keys it reads, so an evaluation can vary one group of thresholds.
 */
export type ReadonlyRankerConfig = DeepReadonly<RankerConfig>;

ALTER TABLE "user_learning_history" ADD COLUMN "reason" text;--> statement-breakpoint
-- Backfill fitted terminal runs only. Missing quality and engine identity stay NULL.
-- Unknown activation or turn-on provenance is false for compatibility with older readers.
-- Existing PRG rows were appended in the training transaction (normally at trained_at).
-- The interval also recognises older appenders whose history clock followed the insert.
WITH model_values AS MATERIALIZED (
  SELECT user_id, version, trained_at, n_labels AS n,
    weights ? 'features' AS fitted, metrics->>'status' AS status,
    CASE WHEN jsonb_typeof(metrics->'cvAuc') = 'number'
      THEN (metrics->>'cvAuc')::double precision END AS auc,
    CASE WHEN jsonb_typeof(metrics->'baselineAuc') = 'number'
      THEN (metrics->>'baselineAuc')::double precision END AS baseline_auc,
    coalesce(metrics->>'status' = 'activated' OR active, false) AS activated,
    CASE WHEN jsonb_typeof(metrics->'turnedOn') = 'boolean'
      THEN (metrics->>'turnedOn')::boolean END AS recorded_turned_on,
    CASE WHEN jsonb_typeof(metrics->'engineModel') = 'string'
      THEN nullif(metrics->>'engineModel', '') END AS engine_model,
    CASE WHEN jsonb_typeof(metrics->'reason') = 'string'
      THEN nullif(metrics->>'reason', '') END AS reason
  FROM user_models
), models AS (
  -- Keep unfitted/superseded versions here: they still establish activation provenance.
  SELECT user_id, version, trained_at, n, fitted, status, auc, baseline_auc, activated,
    recorded_turned_on, engine_model, reason, count(*) OVER prior AS previous_count,
    count(*) FILTER (WHERE status IN ('rejected', 'superseded')) OVER prior AS previous_rejections
  FROM model_values WINDOW prior AS (PARTITION BY user_id ORDER BY version
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
), estimate_values AS MATERIALIZED (
  SELECT user_id, version, trained_at, spec, n,
    CASE WHEN jsonb_typeof(metrics->'auc') = 'number'
      THEN (metrics->>'auc')::double precision END AS auc,
    CASE WHEN jsonb_typeof(metrics->'turnedOn') = 'boolean'
      THEN (metrics->>'turnedOn')::boolean END AS recorded_turned_on
  FROM user_estimate_models
), estimates AS (
  SELECT user_id, version, trained_at, spec, n, auc, recorded_turned_on,
    lag(version) OVER w AS previous_version, lag(spec) OVER w AS previous_spec
  FROM estimate_values WINDOW w AS (PARTITION BY user_id ORDER BY version)
), runs AS (
  SELECT user_id, version, trained_at AS at, 'model'::text AS kind, n, auc, baseline_auc, activated,
    CASE WHEN NOT activated THEN false
      WHEN recorded_turned_on IS NOT NULL THEN recorded_turned_on
      WHEN previous_count = version - 1 AND previous_rejections = previous_count THEN true
      ELSE false END AS turned_on, engine_model, reason,
    min(trained_at) OVER (PARTITION BY user_id ORDER BY trained_at
      GROUPS BETWEEN 1 FOLLOWING AND 1 FOLLOWING) AS next_at
  FROM models
  WHERE fitted AND coalesce(status, '') <> 'superseded'
  UNION ALL
  SELECT user_id, version, trained_at, 'estimate', n, auc, NULL::double precision, false,
    CASE WHEN recorded_turned_on IS NOT NULL THEN recorded_turned_on
      WHEN version = 1 THEN true
      WHEN previous_version = version - 1 THEN previous_spec <> spec ELSE false END,
    NULL::text, NULL::text,
    min(trained_at) OVER (PARTITION BY user_id ORDER BY trained_at
      GROUPS BETWEEN 1 FOLLOWING AND 1 FOLLOWING)
  FROM estimates
), retained AS (
  SELECT user_id, version, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model,
    reason, next_at,
    row_number() OVER (PARTITION BY user_id, kind ORDER BY at DESC, version DESC) AS position
  FROM runs
), numbered AS (
  -- Cap sources too, so replay cannot reinsert a pruned lower version at the same timestamp.
  SELECT user_id, version, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model,
    reason, next_at,
    row_number() OVER (PARTITION BY user_id, kind, at, n, auc ORDER BY version) AS occurrence
  FROM retained WHERE position <= 200
)
INSERT INTO user_learning_history
  (user_id, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model, reason)
SELECT user_id, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model, reason
FROM numbered r
WHERE (
    SELECT count(*) FROM user_learning_history h
    WHERE h.user_id = r.user_id AND h.kind = r.kind AND h.n = r.n
      AND h.auc IS NOT DISTINCT FROM r.auc
      AND h.at >= r.at AND (r.next_at IS NULL OR h.at < r.next_at)
  ) < r.occurrence
ORDER BY user_id, kind, at, version;
--> statement-breakpoint
-- Restore reasons with the same training interval/count/AUC match used above.
-- Count every matching fitted run, including those without a reason; ambiguity stays NULL.
WITH model_run_values AS MATERIALIZED (
  SELECT user_id, trained_at, n_labels,
    CASE WHEN jsonb_typeof(metrics->'cvAuc') = 'number'
      THEN (metrics->>'cvAuc')::double precision END AS auc,
    CASE WHEN jsonb_typeof(metrics->'reason') = 'string'
      THEN nullif(metrics->>'reason', '') END AS reason
  FROM user_models
  WHERE weights ? 'features' AND coalesce(metrics->>'status', '') <> 'superseded'
), model_runs AS (
  SELECT user_id, trained_at, n_labels, auc, reason,
    min(trained_at) OVER (PARTITION BY user_id ORDER BY trained_at
      GROUPS BETWEEN 1 FOLLOWING AND 1 FOLLOWING) AS next_at
  FROM model_run_values
), matches AS (
  SELECT h.id, m.reason, count(*) OVER (PARTITION BY h.id) AS candidates
  FROM user_learning_history h JOIN model_runs m
    ON h.user_id = m.user_id AND h.n = m.n_labels AND h.auc IS NOT DISTINCT FROM m.auc
      AND h.at >= m.trained_at AND (m.next_at IS NULL OR h.at < m.next_at)
  WHERE h.kind = 'model' AND h.reason IS NULL
)
UPDATE user_learning_history h SET reason = m.reason
FROM matches m WHERE h.id = m.id AND m.candidates = 1 AND m.reason IS NOT NULL;
--> statement-breakpoint
DELETE FROM user_learning_history WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY user_id, kind ORDER BY at DESC, id DESC) AS position
    FROM user_learning_history
  ) ranked WHERE position > 200
);

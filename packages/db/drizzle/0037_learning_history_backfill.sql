ALTER TABLE "user_learning_history" ALTER COLUMN "activated" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_learning_history" ALTER COLUMN "turned_on" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_learning_history" ADD COLUMN "reason" text;--> statement-breakpoint
-- Backfill retained runs only. Missing metrics, historical activation state and turn-on
-- provenance stay NULL; never infer a milestone from the oldest surviving version.
-- Existing PRG rows were appended in the training transaction (normally at trained_at).
-- The interval also recognises older appenders whose history clock followed the insert.
WITH models AS (
  SELECT *, lag(version) OVER w AS previous_version, lag(metrics) OVER w AS previous_metrics,
    count(*) OVER prior AS previous_count,
    count(*) FILTER (WHERE metrics->>'status' IN ('rejected', 'superseded')) OVER prior AS previous_rejections
  FROM user_models WINDOW w AS (PARTITION BY user_id ORDER BY version),
    prior AS (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
), estimates AS (
  SELECT *, lag(version) OVER w AS previous_version, lag(spec) OVER w AS previous_spec
  FROM user_estimate_models WINDOW w AS (PARTITION BY user_id ORDER BY version)
), runs AS (
  SELECT user_id, trained_at AS at, 'model'::text AS kind, n_labels AS n,
    CASE WHEN jsonb_typeof(metrics->'cvAuc') = 'number'
      THEN (metrics->>'cvAuc')::double precision END AS auc,
    CASE WHEN jsonb_typeof(metrics->'baselineAuc') = 'number'
      THEN (metrics->>'baselineAuc')::double precision END AS baseline_auc,
    CASE WHEN metrics->>'status' = 'activated' OR active THEN true
      WHEN metrics->>'status' IN ('rejected', 'superseded') THEN false END AS activated,
    CASE WHEN jsonb_typeof(metrics->'turnedOn') = 'boolean' THEN (metrics->>'turnedOn')::boolean
      WHEN metrics->>'status' IN ('rejected', 'superseded') THEN false
      WHEN (metrics->>'status' = 'activated' OR active)
        AND previous_count = version - 1 AND previous_rejections = previous_count THEN true
      WHEN (metrics->>'status' = 'activated' OR active) AND previous_version = version - 1
        AND previous_metrics->>'status' = 'activated'
        AND previous_metrics->>'deactivatedAt' IS NULL THEN false END AS turned_on,
    CASE WHEN jsonb_typeof(metrics->'engineModel') = 'string'
      THEN nullif(metrics->>'engineModel', '') END AS engine_model,
    CASE WHEN jsonb_typeof(metrics->'reason') = 'string'
      THEN nullif(metrics->>'reason', '') END AS reason,
    min(trained_at) OVER (PARTITION BY user_id ORDER BY trained_at
      GROUPS BETWEEN 1 FOLLOWING AND 1 FOLLOWING) AS next_at
  FROM models
  WHERE weights ? 'features' AND coalesce(metrics->>'status', '') <> 'superseded'
  UNION ALL
  SELECT user_id, trained_at, 'estimate', n,
    CASE WHEN jsonb_typeof(metrics->'auc') = 'number' THEN (metrics->>'auc')::double precision END,
    NULL::double precision, NULL::boolean,
    CASE WHEN jsonb_typeof(metrics->'turnedOn') = 'boolean' THEN (metrics->>'turnedOn')::boolean
      WHEN version = 1 THEN true
      WHEN previous_version = version - 1 THEN previous_spec <> spec END,
    NULL::text, NULL::text,
    min(trained_at) OVER (PARTITION BY user_id ORDER BY trained_at
      GROUPS BETWEEN 1 FOLLOWING AND 1 FOLLOWING)
  FROM estimates
), numbered AS (
  SELECT runs.*, row_number() OVER (PARTITION BY user_id, kind, at, n, auc ORDER BY at) AS occurrence
  FROM runs
), missing AS (
  SELECT r.* FROM numbered r
  WHERE (
    SELECT count(*) FROM user_learning_history h
    WHERE h.user_id = r.user_id AND h.kind = r.kind AND h.n = r.n
      AND h.auc IS NOT DISTINCT FROM r.auc
      AND h.at >= r.at AND (r.next_at IS NULL OR h.at < r.next_at)
  ) < r.occurrence
)
INSERT INTO user_learning_history
  (user_id, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model, reason)
SELECT user_id, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model, reason
FROM missing ORDER BY user_id, kind, at;
--> statement-breakpoint
-- Restore rejection reasons on matching PRG rows as well as on the inserted runs.
UPDATE user_learning_history h SET reason = nullif(m.metrics->>'reason', '')
FROM user_models m
WHERE h.user_id = m.user_id AND h.kind = 'model' AND h.n = m.n_labels
  AND h.at = m.trained_at AND h.reason IS NULL
  AND jsonb_typeof(m.metrics->'reason') = 'string'
  AND (SELECT count(*) FROM user_models candidate
       WHERE candidate.user_id = m.user_id AND candidate.trained_at = m.trained_at
         AND candidate.n_labels = m.n_labels) = 1;
--> statement-breakpoint
DELETE FROM user_learning_history WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY user_id, kind ORDER BY at DESC, id DESC) AS position
    FROM user_learning_history
  ) ranked WHERE position > 200
);

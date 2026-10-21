-- Hand-written parts (EST-2, spec 02 §4/§5, spec 08 §5.1): RLS and grants of user_estimate_models, rank_covered() ignores the estimate refresh.
CREATE TABLE "user_estimate_models" (
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"spec" text NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"n" integer NOT NULL,
	"n_pos" integer NOT NULL,
	"n_neg" integer NOT NULL,
	"intercept" double precision NOT NULL,
	"weights" jsonb NOT NULL,
	"platt" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	CONSTRAINT "user_estimate_models_pkey" PRIMARY KEY("user_id","version"),
	CONSTRAINT "user_estimate_models_version_check" CHECK (version >= 1),
	CONSTRAINT "user_estimate_models_counts_check" CHECK (n >= 0 AND n_pos >= 0 AND n_neg >= 0 AND n = n_pos + n_neg)
);
--> statement-breakpoint
ALTER TABLE "user_article" DROP CONSTRAINT "user_article_score_source_check";--> statement-breakpoint
ALTER TABLE "user_estimate_models" ADD CONSTRAINT "user_estimate_models_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article" ADD CONSTRAINT "user_article_score_source_check" CHECK (score_source IN ('none','cards','model','degraded','estimate'));
--> statement-breakpoint
ALTER TABLE user_estimate_models ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_estimate_models FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY user_estimate_models_tenant ON user_estimate_models
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT ON user_estimate_models TO bantoozi_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rank_covered() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user uuid := active_tenant();
BEGIN
  RETURN EXISTS (
           SELECT 1 FROM job_outbox o
            WHERE o.queue = 'user.rank' AND o.delivered_at IS NULL
              AND o.payload->>'userId' = v_user::text
              AND NOT (o.payload ? 'cursor')
              AND NOT (o.payload ? 'estimate'))
         OR EXISTS (
           SELECT 1 FROM pgboss.job j
            WHERE j.name = 'user.rank'
              AND j.singleton_key IN ('rank:' || v_user::text, 'rank-full:' || v_user::text)
              AND j.state IN ('created', 'retry'));
END;
$$;

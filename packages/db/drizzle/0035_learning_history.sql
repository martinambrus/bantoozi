-- Hand-written parts (PRG-1, design 4.5): RLS and the API read grant of user_learning_history.
CREATE TABLE "user_learning_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_learning_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"n" integer NOT NULL,
	"auc" double precision,
	"baseline_auc" double precision,
	"activated" boolean DEFAULT false NOT NULL,
	"turned_on" boolean DEFAULT false NOT NULL,
	"engine_model" text,
	CONSTRAINT "user_learning_history_kind_check" CHECK (kind IN ('model','estimate')),
	CONSTRAINT "user_learning_history_n_check" CHECK (n >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_learning_history" ADD CONSTRAINT "user_learning_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_learning_history_user_idx" ON "user_learning_history" USING btree ("user_id","at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
--> statement-breakpoint
ALTER TABLE user_learning_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_learning_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY user_learning_history_tenant ON user_learning_history
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT ON user_learning_history TO bantoozi_app;

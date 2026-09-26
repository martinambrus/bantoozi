ALTER TABLE "articles" DROP CONSTRAINT "articles_cluster_set_fk";
--> statement-breakpoint
ALTER TABLE "card_suggestions" DROP CONSTRAINT "card_suggestions_question_set_id_question_sets_id_fk";
--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_cluster_set_fk" FOREIGN KEY ("cluster_set_id") REFERENCES "public"."question_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_suggestions" ADD CONSTRAINT "card_suggestions_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE restrict ON UPDATE no action;
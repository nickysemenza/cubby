ALTER TABLE "Suggestion" DROP CONSTRAINT "Suggestion_status_check";--> statement-breakpoint
CREATE INDEX "Suggestion_entity_record_status_idx" ON "Suggestion" USING btree ("entity","recordId","status");--> statement-breakpoint
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_status_check" CHECK ("Suggestion"."status" IN ('pending', 'applied', 'rejected', 'superseded'));
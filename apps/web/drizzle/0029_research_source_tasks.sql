DROP INDEX "RunTarget_run_entity_key";--> statement-breakpoint
ALTER TABLE "RunTarget" ADD COLUMN "workKey" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "RunTarget_run_entity_key" ON "RunTarget" USING btree ("runId","entityId","workKey");
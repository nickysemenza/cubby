ALTER TABLE "Run" DROP CONSTRAINT "Run_trigger_check";--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_import_party_check";--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "routine" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Run_one_active_mail_discovery" ON "Run" USING btree ("ledgerPartyId") WHERE "Run"."purpose" = 'mail_discovery' AND "Run"."status" = 'running';--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_trigger_check" CHECK ("Run"."trigger" IN ('foreground', 'discovery', 'manual', 'backfill', 'scheduled', 'ephemeral'));--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_import_party_check" CHECK ("Run"."purpose" NOT IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'mail_discovery') OR ("Run"."ledgerPartyId" IS NOT NULL AND "Run"."actorLedgerPartyShortcode" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'background', 'file_import', 'mail_search', 'mail_discovery'));
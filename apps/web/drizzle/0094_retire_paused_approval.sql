-- The approval pause is retired (#2667): nothing writes `paused_approval`, and
-- automatic recovery resumed agent Runs through the normal dispatch path. A Run
-- still holding it becomes a member pause, which keeps it in the active
-- vendor-account slot and resumes through that same path. Its operations never
-- executed while awaiting approval, so they fail like any operation of a
-- stopped Run; approval history stays stored.
UPDATE "Run" SET "status" = 'paused', "updatedAt" = now()
WHERE "status" = 'paused_approval';--> statement-breakpoint
UPDATE "RunOperation"
SET "state" = 'failed',
  "error" = COALESCE("error", 'Approval pause retired before the operation ran'),
  "updatedAt" = now()
WHERE "state" = 'paused_approval';--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_status_check";--> statement-breakpoint
ALTER TABLE "RunOperation" DROP CONSTRAINT "RunOperation_state_check";--> statement-breakpoint
DROP INDEX "Run_one_active_vendor_account_key";--> statement-breakpoint
CREATE UNIQUE INDEX "Run_one_active_vendor_account_key" ON "Run" USING btree ("vendorAccountId") WHERE "Run"."vendorAccountId" IS NOT NULL AND "Run"."status" IN ('running', 'paused', 'paused_auth', 'paused_offline');--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_status_check" CHECK ("Run"."status" IN ('running', 'paused', 'paused_auth', 'paused_offline', 'needs_review', 'completed', 'failed', 'dispatch_failed'));--> statement-breakpoint
ALTER TABLE "RunOperation" ADD CONSTRAINT "RunOperation_state_check" CHECK ("RunOperation"."state" IN ('started', 'completed', 'failed'));
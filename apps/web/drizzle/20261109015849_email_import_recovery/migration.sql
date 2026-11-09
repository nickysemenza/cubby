ALTER TABLE "Email" ADD COLUMN "orderKeys" jsonb;--> statement-breakpoint
ALTER TABLE "Email" ADD COLUMN "trackingKeys" jsonb;--> statement-breakpoint
ALTER TABLE "Email" ADD COLUMN "mailKeysChecksum" text;--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "Email_status_check";--> statement-breakpoint
-- `blocked` is retired. A held Email an attempt left without accepted or linked
-- evidence is `unsettled` and keeps its holder Run, outcomes and evidence. An
-- unheld one was retained without import content (ingest's other meaning) and
-- is `pending`. `updatedAt` stays: evidence recovery compares it with the
-- holder's unresolved outcome.
UPDATE "Email" SET status = CASE WHEN "runId" IS NULL THEN 'pending' ELSE 'unsettled' END
WHERE status = 'blocked';--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_status_check" CHECK ("status" IN ('pending', 'researching', 'completed', 'unsettled', 'deleted', 'excluded'));

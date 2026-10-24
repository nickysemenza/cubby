LOCK TABLE "FinancialAccount" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DROP INDEX "FinancialAccount_provisional_idx";--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD COLUMN "primaryCardholderMode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
-- Existing cardholder selections remain explicit even when they match the new default.
UPDATE "FinancialAccount" SET "primaryCardholderMode" = 'explicit' WHERE "primaryCardholderId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "FinancialAccount" DROP COLUMN "provisional";

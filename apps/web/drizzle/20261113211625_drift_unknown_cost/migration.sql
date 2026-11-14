ALTER TABLE "Drift" ALTER COLUMN "estimatedCostMicros" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "Drift" ALTER COLUMN "estimatedCostMicros" DROP NOT NULL;--> statement-breakpoint
-- No feature declared an estimate, so stored proposals that file asks hold a placeholder 0.
UPDATE "Drift" SET "estimatedCostMicros" = NULL WHERE "askCount" > 0;

-- Production drift from the db:push era, absorbed so production and a
-- database built from 0000_baseline both end at schema.ts (compared with
-- tooling/db-catalog.ts against a schema-only restore of production).
-- Idempotent: every statement is guarded, or recreates an identical object.
-- Immutable once merged.

-- Constraint names left behind by table renames and hand-written DDL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Expense"'::regclass AND conname = 'Purchase_pkey') THEN
    ALTER TABLE "Expense" RENAME CONSTRAINT "Purchase_pkey" TO "Expense_pkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Purchase"'::regclass AND conname = 'Purchase_pkey1') THEN
    ALTER TABLE "Purchase" RENAME CONSTRAINT "Purchase_pkey1" TO "Purchase_pkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"OrderMailCandidateDecision"'::regclass AND conname = 'OrderMailCandidateDecision_eventId_fkey') THEN
    ALTER TABLE "OrderMailCandidateDecision" RENAME CONSTRAINT "OrderMailCandidateDecision_eventId_fkey" TO "OrderMailCandidateDecision_eventId_OrderMailEvent_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"OrderMailCandidateDecision"'::regclass AND conname = 'OrderMailCandidateDecision_purchaseId_fkey') THEN
    ALTER TABLE "OrderMailCandidateDecision" RENAME CONSTRAINT "OrderMailCandidateDecision_purchaseId_fkey" TO "OrderMailCandidateDecision_purchaseId_Purchase_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"VendorMailSearchJob"'::regclass AND conname = 'VendorMailSearchJob_runId_fkey') THEN
    ALTER TABLE "VendorMailSearchJob" RENAME CONSTRAINT "VendorMailSearchJob_runId_fkey" TO "VendorMailSearchJob_runId_Run_id_fk";
  END IF;
END $$;--> statement-breakpoint

-- The column default production kept from an earlier model default.
ALTER TABLE "Run" ALTER COLUMN "coordinatorModel" SET DEFAULT 'gpt-6-sol';--> statement-breakpoint

-- schema.ts declares this index NULLS FIRST (Postgres's DESC default): what the
-- feed's ORDER BY "createdAt" DESC, id DESC scans and what production already
-- has. Rebuild it only where the baseline's NULLS LAST shape exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'AuditLog_createdAt_id_idx' AND indexdef LIKE '%NULLS LAST%') THEN
    DROP INDEX "AuditLog_createdAt_id_idx";
    CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog" USING btree ("createdAt" DESC NULLS FIRST, "id" DESC NULLS FIRST);
  END IF;
END $$;--> statement-breakpoint

-- db:push never diffs CHECK expressions: two are equivalent but reordered in
-- production, and two lack values the model has allowed since (widening only).
ALTER TABLE "ImageDerivative" DROP CONSTRAINT IF EXISTS "ImageDerivative_ready_metadata_check", ADD CONSTRAINT "ImageDerivative_ready_metadata_check" CHECK ("ImageDerivative"."status" <> 'ready' OR ("ImageDerivative"."contentType" IS NOT NULL AND "ImageDerivative"."contentType" = 'image/png' AND "ImageDerivative"."sha256" IS NOT NULL AND "ImageDerivative"."width" IS NOT NULL AND "ImageDerivative"."width" > 0 AND "ImageDerivative"."height" IS NOT NULL AND "ImageDerivative"."height" > 0));--> statement-breakpoint
ALTER TABLE "MealFoodEntry" DROP CONSTRAINT IF EXISTS "MealFoodEntry_source_check", ADD CONSTRAINT "MealFoodEntry_source_check" CHECK (("MealFoodEntry"."sourceKind" = 'ingredient' AND "MealFoodEntry"."ingredientId" IS NOT NULL AND "MealFoodEntry"."productId" IS NULL AND "MealFoodEntry"."amount" IS NOT NULL AND "MealFoodEntry"."name" IS NULL AND "MealFoodEntry"."nutrients" IS NULL) OR ("MealFoodEntry"."sourceKind" = 'product' AND "MealFoodEntry"."ingredientId" IS NULL AND "MealFoodEntry"."productId" IS NOT NULL AND "MealFoodEntry"."amount" IS NOT NULL AND "MealFoodEntry"."name" IS NULL AND "MealFoodEntry"."nutrients" IS NULL) OR ("MealFoodEntry"."sourceKind" = 'manual' AND "MealFoodEntry"."ingredientId" IS NULL AND "MealFoodEntry"."productId" IS NULL AND length(trim("MealFoodEntry"."name")) > 0 AND "MealFoodEntry"."name" IS NOT NULL AND "MealFoodEntry"."nutrients" IS NOT NULL AND jsonb_typeof("MealFoodEntry"."nutrients") = 'object' AND "MealFoodEntry"."nutrients" <> '{}'::jsonb));--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT IF EXISTS "Run_status_check", ADD CONSTRAINT "Run_status_check" CHECK ("Run"."status" IN ('running', 'paused_auth', 'paused_offline', 'paused_approval', 'needs_review', 'completed', 'failed', 'dispatch_failed'));--> statement-breakpoint
ALTER TABLE "RunControlEvent" DROP CONSTRAINT IF EXISTS "RunControlEvent_action_check", ADD CONSTRAINT "RunControlEvent_action_check" CHECK ("RunControlEvent"."action" IN ('prompt', 'abort', 'pause', 'resume', 'cancel', 'approve', 'reject', 'retry', 'retry_dispatch', 'upload_evidence', 'no_evidence_available', 'escalate_sol'));

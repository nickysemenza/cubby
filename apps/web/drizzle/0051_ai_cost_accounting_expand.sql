ALTER TABLE "AiUsage" ADD COLUMN "standardCost" double precision;--> statement-breakpoint
ALTER TABLE "AiUsage" ADD COLUMN "chargedCost" double precision;--> statement-breakpoint
ALTER TABLE "AiUsage" ADD COLUMN "costEvidence" jsonb;
--> statement-breakpoint
-- Preserve historical charge and its original estimate without inferring an API comparison.
UPDATE "AiUsage" SET
  "chargedCost" = COALESCE("estimatedCost"::text::double precision, CASE WHEN transport IN ('chatgpt', 'cache') THEN 0 END),
  "costEvidence" = jsonb_build_object(
    'standard', NULL,
    'charged', CASE WHEN "estimatedCost" IS NOT NULL OR transport IN ('chatgpt', 'cache')
      THEN jsonb_build_object('source', 'historical_recorded') ELSE NULL END,
    'billingReason', CASE transport WHEN 'chatgpt' THEN 'plan' WHEN 'cache' THEN 'cache' ELSE 'unknown' END,
    'original', jsonb_build_object('estimatedCost', "estimatedCost")
  );

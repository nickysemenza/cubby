-- Contract for 0041: the classification stage `jev` is now `decision` (Jev or
-- Clef answered; the observation's `model` says which). Apply only after the
-- code that writes `decision` has deployed. Frozen accuracy rosters carry the
-- stage in each stratum, each item and each JSON-encoded stratum id; rewrite
-- all three together so a roster still validates against its own strata.
UPDATE "Email" SET "classificationStage" = 'decision' WHERE "classificationStage" = 'jev';--> statement-breakpoint
UPDATE "EmailClassificationObservation" SET "stage" = 'decision' WHERE "stage" = 'jev';--> statement-breakpoint
UPDATE "EmailAccuracyEvaluation"
SET "roster" = replace(
  replace("roster"::text, '"stage": "jev"', '"stage": "decision"'),
  '[\"jev\",', '[\"decision\",'
)::jsonb
WHERE "roster"::text LIKE '%"stage": "jev"%';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Email" WHERE "classificationStage" = 'jev')
    OR EXISTS (SELECT 1 FROM "EmailClassificationObservation" WHERE "stage" = 'jev')
    OR EXISTS (SELECT 1 FROM "EmailAccuracyEvaluation"
      WHERE "roster"::text LIKE '%"stage": "jev"%' OR "roster"::text LIKE '%[\\"jev\\",%')
  THEN RAISE EXCEPTION 'decision stage contract left a jev stage behind';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "Email_classification_stage_check";--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" DROP CONSTRAINT "EmailClassificationObservation_stage_check";--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_classification_stage_check" CHECK ("classificationStage" IS NULL OR "classificationStage" IN ('rule', 'decision', 'model', 'resolution'));--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_stage_check" CHECK ("EmailClassificationObservation"."stage" IN ('rule', 'decision', 'model', 'resolution'));

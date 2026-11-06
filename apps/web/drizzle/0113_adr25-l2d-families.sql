-- Only serialization keys lived here; there are no domain facts or decisions.
LOCK TABLE "AssessmentCorrectionLock" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP TABLE "AssessmentCorrectionLock";
--> statement-breakpoint
-- No live producer writes these authorities. Refuse retirement of historical
-- decisions rather than reclassifying a member or evaluator's recorded intent.
LOCK TABLE "Suggestion" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE saved record;
BEGIN
  FOR saved IN SELECT id, decisions FROM "Suggestion" LOOP
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(saved.decisions) decision
      WHERE decision->>'authority' IN ('evaluation', 'unknown')) THEN
      RAISE EXCEPTION 'Suggestion % retains a retired feedback authority', saved.id;
    END IF;
  END LOOP;
END $$;

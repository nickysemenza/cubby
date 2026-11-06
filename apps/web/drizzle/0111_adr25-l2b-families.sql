-- Retired flags carry no authority. Refuse to hide a decision on an unserved row.
LOCK TABLE "Suggestion" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM "Suggestion" WHERE NOT served LOOP
    IF item.decisions <> '[]'::jsonb OR item."confirmedValue" IS NOT NULL
       OR item.suppression IS NOT NULL OR item."correctValue" IS NOT NULL
       OR item."acceptanceReceipt" IS NOT NULL OR item.status IN ('applied', 'rejected') THEN
      RAISE EXCEPTION 'Unserved Suggestion % carries a decision', item.id;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DROP INDEX "Suggestion_served_other_id_idx";--> statement-breakpoint
DROP INDEX "Suggestion_served_source_ref_idx";--> statement-breakpoint
DROP INDEX "Suggestion_reference_records_idx";--> statement-breakpoint
CREATE INDEX "Suggestion_served_other_id_idx" ON "Suggestion" USING btree (md5("subject"->>'otherId')) WHERE ("Suggestion"."subject"->>'otherId') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "Suggestion_served_source_ref_idx" ON "Suggestion" USING btree (md5("judgment" #>> '{create,sourceRef,source}'),md5("judgment" #>> '{create,sourceRef,externalId}')) WHERE ("Suggestion"."judgment" #>> '{create,sourceRef,source}') IS NOT NULL AND ("Suggestion"."judgment" #>> '{create,sourceRef,externalId}') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "Suggestion_reference_records_idx" ON "Suggestion" USING gin (("evidence"->'records'));--> statement-breakpoint
ALTER TABLE "Suggestion" DROP COLUMN "served";
-- Unserved rows were trial output: never member review candidates and never
-- automatic decisions. Retire them as inactive history so trials stay out of
-- member work and carry no authority; every stored column is otherwise kept.
LOCK TABLE "Suggestion" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE l2b_suggestion_preimage ON COMMIT DROP AS SELECT * FROM "Suggestion";
UPDATE "Suggestion" SET active = false WHERE NOT served AND active;
DO $$ BEGIN
  IF (SELECT count(*) FROM "Suggestion") <> (SELECT count(*) FROM l2b_suggestion_preimage)
     OR EXISTS (SELECT 1 FROM "Suggestion" WHERE NOT served AND active)
     OR EXISTS (
       SELECT 1 FROM l2b_suggestion_preimage o LEFT JOIN "Suggestion" n ON n.id = o.id
       WHERE n.id IS NULL
          OR (to_jsonb(n) - 'active') IS DISTINCT FROM (to_jsonb(o) - 'active')
          OR (o.served AND n.active IS DISTINCT FROM o.active)) THEN
    RAISE EXCEPTION 'Unserved Suggestion retirement did not preserve a row';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX "Suggestion_served_other_id_idx";--> statement-breakpoint
DROP INDEX "Suggestion_served_source_ref_idx";--> statement-breakpoint
DROP INDEX "Suggestion_reference_records_idx";--> statement-breakpoint
CREATE INDEX "Suggestion_served_other_id_idx" ON "Suggestion" USING btree (md5("subject"->>'otherId')) WHERE ("Suggestion"."subject"->>'otherId') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "Suggestion_served_source_ref_idx" ON "Suggestion" USING btree (md5("judgment" #>> '{create,sourceRef,source}'),md5("judgment" #>> '{create,sourceRef,externalId}')) WHERE ("Suggestion"."judgment" #>> '{create,sourceRef,source}') IS NOT NULL AND ("Suggestion"."judgment" #>> '{create,sourceRef,externalId}') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "Suggestion_reference_records_idx" ON "Suggestion" USING gin (("evidence"->'records'));--> statement-breakpoint
ALTER TABLE "Suggestion" DROP COLUMN "served";
--> statement-breakpoint
CREATE INDEX "Suggestion_connection_source_ref_idx" ON "Suggestion"
 ((evidence #>> '{candidate,source,entityKind}'), (evidence #>> '{candidate,source,entityId}')) INCLUDE (id)
 WHERE subject->>'scope' LIKE 'connection.%';
--> statement-breakpoint
CREATE INDEX "Suggestion_connection_target_ref_idx" ON "Suggestion"
 ((evidence #>> '{candidate,target,entityKind}'), (evidence #>> '{candidate,target,entityId}')) INCLUDE (id)
 WHERE subject->>'scope' LIKE 'connection.%';

-- cubby:transaction-per-statement
-- See 0073 for how this mode behaves against live writers.
-- A Job's old identity row owes nothing: no table references one, and no Worker reads or
-- writes them since the job entity retirement's Worker deployed. The unfinished Job rows themselves stay.
-- cubby:repeat-batch
WITH doomed AS (
  SELECT id FROM "Entity" WHERE kind = 'job' ORDER BY id LIMIT 2000 FOR UPDATE SKIP LOCKED
), gone AS (
  DELETE FROM "Entity" e USING doomed d WHERE e.id = d.id RETURNING e.id
)
SELECT (SELECT count(*) FROM gone) = 2000 AS remaining;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Entity" WHERE kind = 'job') THEN
    RAISE EXCEPTION 'Job identities remain after the prune';
  END IF;
END $$;
ALTER TABLE "Entity" VALIDATE CONSTRAINT "Entity_kind_check";
ALTER TABLE "Entity" VALIDATE CONSTRAINT "Entity_shortcode_prefix_check";--> statement-breakpoint
ALTER TABLE "Job" DROP COLUMN IF EXISTS "shortcode";--> statement-breakpoint
DROP TABLE IF EXISTS "JobLaneAdmission";

ALTER TABLE "WorkItem" DROP CONSTRAINT "DerivedDirty_no_retired_automatic_fields";--> statement-breakpoint
DROP INDEX "DerivedDirty_ready_idx";--> statement-breakpoint
ALTER TABLE "WorkItem" ALTER COLUMN "ticket" SET DEFAULT nextval('"WorkTicket"');--> statement-breakpoint
ALTER TABLE "WorkItem" ADD COLUMN "drain" text DEFAULT 'derived:drain' NOT NULL;--> statement-breakpoint
CREATE INDEX "WorkItem_ready_idx" ON "WorkItem" USING btree ("drain","priority","readyAt");--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "WorkItem" (target, ref, priority)
    SELECT DISTINCT p_target, r,
      CASE current_setting('cubby.derived_priority', true) WHEN '1' THEN 1 ELSE 0 END
    FROM unnest(p_refs) AS r WHERE r IS NOT NULL
  ON CONFLICT (target, ref) DO UPDATE SET
    ticket = nextval('"WorkTicket"'),
    priority = LEAST("WorkItem".priority, EXCLUDED.priority),
    "readyAt" = now(),
    attempts = 0,
    "lastError" = NULL;
  IF current_setting('cubby.derived_capture', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      VALUES ('derived:drain', now() AT TIME ZONE 'UTC');
    PERFORM set_config('cubby.derived_capture', txid_current()::text, true);
  END IF;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Job_never_exhausted_failure" ON "Job";--> statement-breakpoint
DROP FUNCTION IF EXISTS job_never_exhausted_failure();

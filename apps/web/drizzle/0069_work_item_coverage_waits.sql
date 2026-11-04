ALTER TABLE "WorkItem" ADD COLUMN "waitCause" text;--> statement-breakpoint
ALTER TABLE "WorkItem" ADD COLUMN "waitStartedAt" timestamp;--> statement-breakpoint
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_wait_check" CHECK (("WorkItem"."waitCause" IS NULL AND "WorkItem"."waitStartedAt" IS NULL) OR ("WorkItem"."waitCause" IN ('search_coverage') AND "WorkItem"."waitCause" IS NOT NULL AND "WorkItem"."waitStartedAt" IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[], p_reason text DEFAULT 'Refresh requested') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "WorkItem" (target, ref, priority, reason)
    SELECT DISTINCT p_target, r,
      CASE current_setting('cubby.derived_priority', true) WHEN '1' THEN 1 ELSE 0 END, p_reason
    FROM unnest(p_refs) AS r WHERE r IS NOT NULL
  ON CONFLICT (target, ref) DO UPDATE SET
    reason = EXCLUDED.reason,
    ticket = nextval('"WorkTicket"'),
    priority = LEAST("WorkItem".priority, EXCLUDED.priority),
    "readyAt" = now(),
    attempts = 0,
    "lastError" = NULL,
    "waitCause" = NULL,
    "waitStartedAt" = NULL;
  IF current_setting('cubby.derived_capture', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      VALUES ('derived:drain', now() AT TIME ZONE 'UTC');
    PERFORM set_config('cubby.derived_capture', txid_current()::text, true);
  END IF;
END $$;

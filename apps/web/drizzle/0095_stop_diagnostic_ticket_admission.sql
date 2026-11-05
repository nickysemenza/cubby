-- cubby:transaction-per-statement
SET lock_timeout = '2s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[], p_reason text DEFAULT 'Refresh requested') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF split_part(p_target, '@', 1) IN ('project.workDiagnosticFacts') THEN RETURN; END IF;
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
    "waitStartedAt" = NULL,
    "fanoutAfter" = NULL;
  IF current_setting('cubby.derived_capture', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      VALUES ('derived:drain', now() AT TIME ZONE 'UTC');
    PERFORM set_config('cubby.derived_capture', txid_current()::text, true);
  END IF;
END $$;

--> statement-breakpoint
RESET lock_timeout;

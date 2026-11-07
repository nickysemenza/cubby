SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "McpToolCall" ADD COLUMN "action" text;--> statement-breakpoint
ALTER TABLE "McpToolCall" ADD COLUMN "errorKind" text;
--> statement-breakpoint
-- A retired Run can no longer work on an Email it holds; only a member's retry can
-- move it. The status now says so. Nothing but this label changes.
UPDATE "Email" e SET status = 'blocked', "updatedAt" = now()
FROM "Run" r
WHERE r.id = e."runId" AND e.status = 'researching'
  AND r.purpose = 'mail_import' AND r.status IN ('failed', 'needs_review')
  AND r."retiredAt" IS NOT NULL;
--> statement-breakpoint
-- These Runs' coordinators never started, so nothing else would ever admit their
-- Emails. Clearing the replay key lets the same source set start a new Run.
WITH released AS (
  UPDATE "Email" e SET status = 'pending', "runId" = NULL, "updatedAt" = now()
  FROM "Run" r
  WHERE r.id = e."runId" AND e.status = 'researching'
    AND r.purpose = 'mail_import' AND r.status = 'dispatch_failed'
    AND r."coordinatorStartedAt" IS NULL
  RETURNING r.id
)
UPDATE "Run" r SET "clientKey" = NULL WHERE r.id IN (SELECT id FROM released);
--> statement-breakpoint
DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Email" e JOIN "Run" r ON r.id = e."runId"
    WHERE e.status = 'researching' AND r.purpose = 'mail_import'
      AND (r.status = 'dispatch_failed'
        OR (r.status IN ('failed', 'needs_review') AND r."retiredAt" IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'An ended Run still shows an Email as researching';
  END IF;
END $check$;

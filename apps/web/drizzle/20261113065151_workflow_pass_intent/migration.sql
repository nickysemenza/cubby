-- RunStep and Run.progress retain their checkpoints. Only execution ownership moves.
INSERT INTO "Pass" (name, key, cursor, "runId", attempts, "maxAttempts", "availableAt", "waitCause", "lastError", "cancelledAt")
SELECT 'run.execute', r.id::text,
  jsonb_build_object('runId', r.id::text, 'purpose', r.purpose, 'generation', j.generation),
  r.id, j.attempts, j."maxAttempts", j."availableAt",
  CASE j."waitReason" WHEN 'ai_funding_window' THEN 'funding' ELSE j."waitReason" END,
  j.error, CASE WHEN j.state = 'paused' THEN coalesce(j."updatedAt", now()) ELSE NULL END
FROM "Job" j JOIN "Run" r ON r.id = j."runId"
WHERE j.kind = 'run.execute' AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed')
  AND r.purpose IN ('sweep', 'maintenance', 'ai_refresh', 'mail_reclassify', 'connection_discovery')
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name, key, cursor, "availableAt", attempts, "maxAttempts", "lastError", "cancelledAt")
SELECT 'purchase.discovery', 'default', jsonb_build_object('senderAfter', coalesce(j.input->'senderAfter', 'null'::jsonb)),
  j."availableAt", j.attempts, j."maxAttempts", j.error,
  CASE WHEN j.state = 'paused' THEN j."updatedAt" ELSE NULL END
FROM "Job" j WHERE j.kind = 'maintenance.purchase-discovery'
  AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed')
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name, key, cursor, "availableAt", attempts, "maxAttempts", "lastError", "cancelledAt")
SELECT 'calendar.invalidate', coalesce(j.input->>'origin', j.key),
  jsonb_build_object('origin', coalesce(j.input->>'origin', j.key), 'reason', coalesce(j.input->>'reason', 'change')),
  j."availableAt", j.attempts, j."maxAttempts", j.error,
  CASE WHEN j.state = 'paused' THEN j."updatedAt" ELSE NULL END
FROM "Job" j WHERE j.kind = 'calendar-feed.mark-dirty'
  AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed')
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "Job" j JOIN "Run" r ON r.id = j."runId"
    WHERE j.kind = 'run.execute' AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed')
      AND r.purpose IN ('sweep', 'maintenance', 'ai_refresh', 'mail_reclassify', 'connection_discovery')
      AND NOT EXISTS (SELECT 1 FROM "Pass" p WHERE p.name = 'run.execute' AND p.key = r.id::text
        AND p.cursor->>'runId' = r.id::text AND p.cursor->>'purpose' = r.purpose
        AND p.cursor->>'generation' = j.generation::text AND p."runId" = r.id)
  ) THEN RAISE EXCEPTION 'Run execution checkpoint did not carry into its Pass'; END IF;
  IF EXISTS (
    SELECT 1 FROM "Job" j WHERE j.kind IN ('maintenance.purchase-discovery', 'calendar-feed.mark-dirty')
      AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed')
      AND NOT EXISTS (SELECT 1 FROM "Pass" p WHERE
        (j.kind = 'maintenance.purchase-discovery' AND p.name = 'purchase.discovery' AND p.key = 'default'
          AND p.cursor->'senderAfter' = coalesce(j.input->'senderAfter', 'null'::jsonb))
        OR (j.kind = 'calendar-feed.mark-dirty' AND p.name = 'calendar.invalidate'
          AND p.key = coalesce(j.input->>'origin', j.key)
          AND p.cursor->>'origin' = coalesce(j.input->>'origin', j.key)))
  ) THEN RAISE EXCEPTION 'Background intent did not carry into its Pass'; END IF;
END $$;
--> statement-breakpoint
DELETE FROM "Job" j WHERE j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed') AND (
  j.kind IN ('maintenance.purchase-discovery', 'calendar-feed.mark-dirty')
  OR (j.kind = 'run.execute' AND EXISTS (SELECT 1 FROM "Run" r WHERE r.id = j."runId"
    AND r.purpose IN ('sweep', 'maintenance', 'ai_refresh', 'mail_reclassify', 'connection_discovery')))
);

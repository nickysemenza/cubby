-- RunStep and Run.progress retain their checkpoints. Only execution ownership moves.
INSERT INTO "Pass" (name, key, cursor, "runId", attempts, "maxAttempts", "availableAt", "waitCause", "lastError", "cancelledAt")
SELECT 'run.execute', r.id::text,
  jsonb_build_object('runId', r.id::text, 'purpose', r.purpose, 'generation', j.generation),
  r.id, CASE WHEN j.state='failed' THEN greatest(j.attempts,coalesce(j."maxAttempts",3)) ELSE j.attempts END, coalesce(j."maxAttempts",3), j."availableAt",
  CASE j."waitReason" WHEN 'ai_funding_window' THEN 'funding' ELSE j."waitReason" END,
  j.error, CASE WHEN j.state IN ('paused','cancelled') THEN coalesce(j."updatedAt", now()) ELSE NULL END
FROM "Job" j JOIN "Run" r ON r.id = j."runId"
WHERE j.kind = 'run.execute' AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed', 'cancelled')
  AND r.purpose IN ('sweep', 'maintenance', 'ai_refresh', 'mail_reclassify', 'connection_discovery')
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name, key, cursor, "availableAt", attempts, "maxAttempts", "lastError", "cancelledAt", "waitCause")
SELECT 'purchase.discovery', 'default', jsonb_build_object('senderAfter', coalesce(j.input->'senderAfter', 'null'::jsonb)),
  j."availableAt", CASE WHEN j.state='failed' THEN greatest(j.attempts,coalesce(j."maxAttempts",3)) ELSE j.attempts END, coalesce(j."maxAttempts",3), j.error,
  CASE WHEN j.state IN ('paused','cancelled') THEN j."updatedAt" ELSE NULL END,
  CASE j."waitReason" WHEN 'ai_funding_window' THEN 'funding' ELSE j."waitReason" END
FROM "Job" j WHERE j.kind = 'maintenance.purchase-discovery'
  AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed', 'cancelled')
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name, key, cursor, "availableAt", attempts, "maxAttempts", "lastError", "cancelledAt", "waitCause")
SELECT 'calendar.invalidate', coalesce(j.input->>'origin', j.key),
  jsonb_build_object('origin', coalesce(j.input->>'origin', j.key), 'reason', coalesce(j.input->>'reason', 'change')),
  j."availableAt", CASE WHEN j.state='failed' THEN greatest(j.attempts,coalesce(j."maxAttempts",3)) ELSE j.attempts END, coalesce(j."maxAttempts",3), j.error,
  CASE WHEN j.state IN ('paused','cancelled') THEN j."updatedAt" ELSE NULL END,
  CASE j."waitReason" WHEN 'ai_funding_window' THEN 'funding' ELSE j."waitReason" END
FROM "Job" j WHERE j.kind = 'calendar-feed.mark-dirty'
  AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed', 'cancelled')
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name, key, cursor, "runId", "availableAt", "waitCause", "cancelledAt")
SELECT 'run.execute', r.id::text,
  jsonb_build_object('runId', r.id::text, 'purpose', r.purpose,
    'generation', greatest(coalesce((r.progress->>'attempt')::int, 1), 1)),
  r.id, coalesce(funding.until, now()), CASE WHEN funding.until IS NOT NULL THEN 'funding' END,
  CASE WHEN r.status = 'paused' THEN now() END
FROM "Run" r LEFT JOIN LATERAL (
  SELECT min((j.input->>'until')::timestamp) AS until FROM "Job" j
  WHERE j.kind = 'run.funding-resume' AND j.state IN ('queued', 'retry_wait', 'running')
    AND r.status = 'paused_auth' AND r."failureCode" = 'execution_limit'
    AND (j.input->>'until')::timestamp > now()
) funding ON true
WHERE r.purpose IN ('sweep', 'maintenance', 'ai_refresh', 'mail_reclassify', 'connection_discovery')
  AND r.status IN ('running', 'paused_auth', 'paused') AND r."deletedAt" IS NULL AND r."retiredAt" IS NULL
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "Job" j JOIN "Run" r ON r.id = j."runId"
    WHERE j.kind = 'run.execute' AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed', 'cancelled')
      AND r.purpose IN ('sweep', 'maintenance', 'ai_refresh', 'mail_reclassify', 'connection_discovery')
      AND NOT EXISTS (SELECT 1 FROM "Pass" p WHERE p.name = 'run.execute' AND p.key = r.id::text
        AND p.cursor->>'runId' = r.id::text AND p.cursor->>'purpose' = r.purpose
        AND p.cursor->>'generation' = j.generation::text AND p."runId" = r.id
        AND p.attempts = CASE WHEN j.state='failed' THEN greatest(j.attempts,coalesce(j."maxAttempts",3)) ELSE j.attempts END AND p."maxAttempts" = coalesce(j."maxAttempts",3) AND p."availableAt" = j."availableAt"
        AND p."lastError" IS NOT DISTINCT FROM j.error
        AND p."waitCause" IS NOT DISTINCT FROM CASE j."waitReason" WHEN 'ai_funding_window' THEN 'funding' ELSE j."waitReason" END
        AND (p."cancelledAt" IS NOT NULL) = (j.state IN ('paused','cancelled')))
  ) THEN RAISE EXCEPTION 'Run execution checkpoint did not carry into its Pass'; END IF;
  IF EXISTS (
    SELECT 1 FROM "Job" j WHERE j.kind IN ('maintenance.purchase-discovery', 'calendar-feed.mark-dirty')
      AND j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM "Pass" p WHERE p.attempts = CASE WHEN j.state='failed' THEN greatest(j.attempts,coalesce(j."maxAttempts",3)) ELSE j.attempts END AND p."maxAttempts" = coalesce(j."maxAttempts",3)
        AND p."availableAt" = j."availableAt" AND p."lastError" IS NOT DISTINCT FROM j.error
        AND p."waitCause" IS NOT DISTINCT FROM CASE j."waitReason" WHEN 'ai_funding_window' THEN 'funding' ELSE j."waitReason" END
        AND (p."cancelledAt" IS NOT NULL) = (j.state IN ('paused','cancelled')) AND (
        (j.kind = 'maintenance.purchase-discovery' AND p.name = 'purchase.discovery' AND p.key = 'default'
          AND p.cursor->'senderAfter' = coalesce(j.input->'senderAfter', 'null'::jsonb))
        OR (j.kind = 'calendar-feed.mark-dirty' AND p.name = 'calendar.invalidate'
          AND p.key = coalesce(j.input->>'origin', j.key)
          AND p.cursor->>'origin' = coalesce(j.input->>'origin', j.key)
          AND p.cursor->>'reason' = coalesce(j.input->>'reason', 'change'))))
  ) THEN RAISE EXCEPTION 'Background intent did not carry into its Pass'; END IF;
END $$;
--> statement-breakpoint
DELETE FROM "Job" j WHERE j.state IN ('queued', 'running', 'retry_wait', 'paused', 'failed', 'cancelled') AND (
  j.kind IN ('maintenance.purchase-discovery', 'calendar-feed.mark-dirty')
  OR (j.kind = 'run.execute' AND EXISTS (SELECT 1 FROM "Run" r WHERE r.id = j."runId"
    AND r.purpose IN ('sweep', 'maintenance', 'ai_refresh', 'mail_reclassify', 'connection_discovery')))
);

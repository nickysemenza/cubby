-- Coalesced work retains every source receipt and resumes from the earliest
-- unvisited checkpoint. A terminal Run never becomes claimable through a Job.
LOCK TABLE "Job", "Run", "Pass" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE workflow_intent_sources ON COMMIT DROP AS
SELECT j.*,r.status run_status,
 CASE j.kind WHEN 'run.execute' THEN 'run.execute' WHEN 'maintenance.purchase-discovery' THEN 'purchase.discovery' ELSE 'calendar.invalidate' END pass_name,
 CASE j.kind WHEN 'run.execute' THEN r.id::text WHEN 'maintenance.purchase-discovery' THEN 'default' ELSE coalesce(j.input->>'origin',j.key) END pass_key,
 CASE j.kind WHEN 'run.execute' THEN jsonb_build_object('runId',r.id::text,'purpose',r.purpose,'generation',j.generation)
 WHEN 'maintenance.purchase-discovery' THEN jsonb_build_object('senderAfter',coalesce(j.input->'senderAfter','null'::jsonb))
 ELSE jsonb_build_object('origin',coalesce(j.input->>'origin',j.key),'reason',coalesce(j.input->>'reason','change')) END pass_cursor
FROM "Job" j LEFT JOIN "Run" r ON r.id=j."runId"
WHERE j.state IN ('queued','running','retry_wait','paused','failed','cancelled') AND
 (j.kind IN ('maintenance.purchase-discovery','calendar-feed.mark-dirty') OR j.kind='run.execute' AND r.purpose IN ('sweep','maintenance','ai_refresh','mail_reclassify','connection_discovery'));
--> statement-breakpoint
CREATE TEMP TABLE workflow_intents ON COMMIT DROP AS
SELECT DISTINCT ON (pass_name,pass_key) s.*,
 CASE WHEN pass_name='purchase.discovery' THEN
 (SELECT t.pass_cursor FROM workflow_intent_sources t WHERE t.pass_name=s.pass_name AND t.pass_key=s.pass_key
 ORDER BY (t.pass_cursor->'senderAfter' IS DISTINCT FROM 'null'::jsonb),
 t.pass_cursor->'senderAfter'->>'mailboxId' COLLATE "C" NULLS FIRST,
 t.pass_cursor->'senderAfter'->>'afterId' COLLATE "C" NULLS FIRST,t.id LIMIT 1)
 ELSE pass_cursor END selected_cursor,
 (SELECT min(t."availableAt") FROM workflow_intent_sources t WHERE t.pass_name=s.pass_name AND t.pass_key=s.pass_key) first_available,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM workflow_intent_sources t WHERE t.pass_name=s.pass_name AND t.pass_key=s.pass_key) receipts
FROM workflow_intent_sources s
ORDER BY pass_name,pass_key,
 -- Live intent wins over a stopped duplicate; one stopped receipt cannot stop
 -- independent runnable work. Run generations use the newest durable attempt.
 (state IN ('queued','running','retry_wait')) DESC,
 CASE WHEN pass_name='run.execute' THEN generation END DESC,
 (pass_cursor->'senderAfter' IS DISTINCT FROM 'null'::jsonb),
 pass_cursor->'senderAfter'->>'mailboxId' COLLATE "C" NULLS FIRST,
 pass_cursor->'senderAfter'->>'afterId' COLLATE "C" NULLS FIRST,
 "updatedAt" DESC,id;
--> statement-breakpoint
INSERT INTO "Pass" (name,key,cursor,"runId",attempts,"maxAttempts","availableAt","waitCause","lastError","cancelledAt")
SELECT pass_name,pass_key,selected_cursor||jsonb_build_object('legacyJobs',receipts),
 CASE WHEN pass_name='run.execute' THEN "runId" END,
 CASE WHEN state='failed' OR run_status='failed' THEN greatest(attempts,coalesce("maxAttempts",3)) ELSE attempts END,
 coalesce("maxAttempts",3),first_available,
 CASE "waitReason" WHEN 'ai_funding_window' THEN 'funding' ELSE "waitReason" END,error,
 CASE WHEN state IN ('paused','cancelled') OR pass_name='run.execute' AND run_status NOT IN ('running','paused_auth') THEN coalesce("updatedAt",now()) END
FROM workflow_intents
ON CONFLICT (name,key) DO NOTHING;
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
 IF EXISTS (SELECT 1 FROM workflow_intents e WHERE NOT EXISTS (
   SELECT 1 FROM "Pass" p WHERE p.name=e.pass_name AND p.key=e.pass_key
   AND p.cursor=e.selected_cursor||jsonb_build_object('legacyJobs',e.receipts)
   AND p."availableAt"=e.first_available
   AND p.attempts=CASE WHEN e.state='failed' OR e.run_status='failed' THEN greatest(e.attempts,coalesce(e."maxAttempts",3)) ELSE e.attempts END
   AND p."maxAttempts"=coalesce(e."maxAttempts",3)
   AND p."lastError" IS NOT DISTINCT FROM e.error
   AND p."waitCause" IS NOT DISTINCT FROM CASE e."waitReason" WHEN 'ai_funding_window' THEN 'funding' ELSE e."waitReason" END
   AND (p."cancelledAt" IS NOT NULL)=(e.state IN ('paused','cancelled') OR e.pass_name='run.execute' AND e.run_status NOT IN ('running','paused_auth'))
 )) THEN RAISE EXCEPTION 'Background intent did not carry into its Pass'; END IF;
 IF (SELECT count(*) FROM workflow_intent_sources)<>(SELECT coalesce(sum(jsonb_array_length(p.cursor->'legacyJobs')),0) FROM "Pass" p JOIN workflow_intents e ON p.name=e.pass_name AND p.key=e.pass_key)
 THEN RAISE EXCEPTION 'Background intent source count mismatch'; END IF;
END $$;
--> statement-breakpoint
DELETE FROM "Job" j USING workflow_intent_sources s WHERE j.id=s.id;

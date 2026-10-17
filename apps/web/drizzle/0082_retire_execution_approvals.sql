-- Contraction for automatic Mail import (#2601). Applied by the ordinary
-- deploy just before the new Worker; the member accepted brief failures from the
-- predecessor Worker reading these shapes in that window.
-- Execution approvals are retired. Approval-root Runs and their receipts stay
-- as history; strict Run input schemas refuse the stale reference key.
UPDATE "AiEvaluation"
SET "snapshot" = "snapshot" - 'executionAuthorization' - 'authorizationHistory' - 'minimumBudgetMicroUSD'
WHERE jsonb_typeof("snapshot") = 'object'
  AND ("snapshot" ?| ARRAY['executionAuthorization', 'authorizationHistory', 'minimumBudgetMicroUSD']);--> statement-breakpoint
-- Discovery now imports under the Mail import switch. Close unfinished passes
-- the predecessor Worker started (classification-only, per-Vendor history or
-- approval-bound) so none resumes under its retired scope or holds the
-- one-active-discovery slot; the next scheduled pass restarts from the mailbox
-- cursor. Passes the current Worker started (`import`, no retired keys) stay.
UPDATE "Run"
SET "status" = 'completed', "endedAt" = COALESCE("endedAt", now()),
  "failureCode" = 'discovery_policy_replaced',
  "dispatchError" = 'Discovery was replaced by automatic Mail import; the next scheduled pass restarts from the mailbox cursor.'
WHERE "purpose" = 'mail_discovery'
  AND "status" NOT IN ('completed', 'failed', 'dispatch_failed')
  AND ("input"->>'executionPolicy' IS DISTINCT FROM 'import'
    OR "input" ?| ARRAY['vendorHistory', 'executionAuthorization']);--> statement-breakpoint
UPDATE "Run" SET "input" = "input" - 'executionAuthorization'
WHERE jsonb_typeof("input") = 'object' AND "input" ? 'executionAuthorization';--> statement-breakpoint
UPDATE "Run" SET "input" = "input" - 'vendorHistory'
WHERE "purpose" = 'mail_discovery' AND "input" ? 'vendorHistory';--> statement-breakpoint
-- Legacy `vendor:<id>` scoped queries searched the Vendor name as free text.
-- Drop them from mailbox coverage; literal sender/domain queries replace them
-- on the next pass. History positions and other scoped queries are kept.
UPDATE "MailboxCursor"
SET "coverage" = jsonb_set("coverage", '{scoped}', COALESCE((
  SELECT jsonb_agg(query ORDER BY position)
  FROM jsonb_array_elements("coverage"->'scoped') WITH ORDINALITY AS scoped(query, position)
  WHERE query->>'key' !~ '^vendor:[^:]+$'
), '[]'::jsonb))
WHERE jsonb_typeof("coverage"->'scoped') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("coverage"->'scoped') AS scoped(query)
    WHERE query->>'key' ~ '^vendor:[^:]+$'
  );

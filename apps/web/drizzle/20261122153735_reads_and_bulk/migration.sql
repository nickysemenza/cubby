DROP INDEX "EntityEmbedding_model_idx";--> statement-breakpoint
DROP INDEX "McpToolCall_tool_occurredAt_idx";--> statement-breakpoint
DROP INDEX "McpToolCall_user_occurredAt_idx";--> statement-breakpoint
DROP INDEX "McpToolCall_client_occurredAt_idx";--> statement-breakpoint
DROP INDEX "McpToolCall_outcome_idx";--> statement-breakpoint
DROP INDEX "McpToolCall_entity_occurredAt_idx";--> statement-breakpoint
CREATE INDEX "EntityEmbedding_cleanup_idx" ON "EntityEmbedding" ("id") WHERE "deletionId" IS NULL AND ("deletedAt" IS NOT NULL OR "artifactState" IN ('retired','failed')) AND "artifactState" <> 'selected';--> statement-breakpoint
CREATE INDEX "McpToolCall_occurredAt_idx" ON "McpToolCall" ("occurredAt");--> statement-breakpoint

-- CLUSTER, DELETE and UPDATE are invisible to the runner's lock detection.
LOCK TABLE "EntityEmbedding", "Suggestion", "ShipmentSourceCapture", "OrderMail" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- Archive preimages the owner authorised dropping. No foreign keys, views or
-- code reference them; the remaining archive tables stay.
DROP TABLE archive."AiEvaluation_preimage";
--> statement-breakpoint
DROP TABLE archive."AiEvaluationRequest_preimage";
--> statement-breakpoint
DROP TABLE archive."Suggestion_convergence_preimage";
--> statement-breakpoint
DROP TABLE archive."FinancialEvidenceAlias_convergence_preimage";
--> statement-breakpoint

-- Retired statement_transaction Suggestions that were superseded with no
-- decision or authority of their own: the exact predicate
-- pruneReplacedSuggestions (generic/suggestions/repo/suggestion-publication.ts)
-- applies when a replacement is published, restricted to that family. No live
-- code publishes the family; field rows (read by the decision-grading skill)
-- are untouched. No foreign key or column elsewhere references Suggestion.
-- Production read-only count: 34,734 rows, ~139 MB of row data.
DO $$
DECLARE
  before_count bigint;
  doomed bigint;
  after_count bigint;
BEGIN
  SELECT count(*) INTO before_count FROM "Suggestion";
  DELETE FROM "Suggestion"
  WHERE family = 'statement_transaction'
    AND status = 'superseded'
    AND decisions = '[]'::jsonb
    AND suppression IS NULL
    AND "confirmedValue" IS NULL
    AND "acceptanceReceipt" IS NULL;
  GET DIAGNOSTICS doomed = ROW_COUNT;
  CREATE TEMP TABLE suggestion_keep ON COMMIT DROP AS SELECT * FROM "Suggestion";
  TRUNCATE "Suggestion";
  INSERT INTO "Suggestion" SELECT * FROM suggestion_keep;
  SELECT count(*) INTO after_count FROM "Suggestion";
  IF after_count <> before_count - doomed
    OR EXISTS (SELECT 1 FROM suggestion_keep k WHERE NOT EXISTS (
      SELECT 1 FROM "Suggestion" s WHERE s.id = k.id AND to_jsonb(s) = to_jsonb(k)))
  THEN
    RAISE EXCEPTION 'Suggestion prune: preservation mismatch';
  END IF;
END $$;
--> statement-breakpoint
ANALYZE "Suggestion";
--> statement-breakpoint

CLUSTER "EntityEmbedding" USING "EntityEmbedding_pkey";
--> statement-breakpoint
ALTER TABLE "EntityEmbedding" SET WITHOUT CLUSTER;
--> statement-breakpoint
ANALYZE "EntityEmbedding";
--> statement-breakpoint

CLUSTER "ShipmentSourceCapture" USING "ShipmentSourceCapture_pkey";
--> statement-breakpoint
ALTER TABLE "ShipmentSourceCapture" SET WITHOUT CLUSTER;
--> statement-breakpoint
ANALYZE "ShipmentSourceCapture";
--> statement-breakpoint

-- OrderMail: only a CLUSTER-safe rewrite if no statement in this migration
-- UPDATEs or DELETEs its rows (CLUSTER would copy those old versions). A
-- column DROP in this migration is fine: CLUSTER nulls dropped columns.
CLUSTER "OrderMail" USING "OrderMail_pkey";
--> statement-breakpoint
ALTER TABLE "OrderMail" SET WITHOUT CLUSTER;
--> statement-breakpoint
ANALYZE "OrderMail";
--> statement-breakpoint

-- Completed ordinary discovery Runs never read their frozen query roster
-- again: keep the query each searched. Controlled Runs keep theirs as coverage
-- evidence, and a Run with an Ask scope or step can still be relaunched. The
-- controlled test is in SET so only candidates are detoasted.
WITH candidate AS MATERIALIZED (
  SELECT r.id FROM "Run" r
  WHERE r.purpose = 'mail_discovery'
    AND r.status = 'completed'
    AND r."endedAt" < now() - interval '1 hour'
    -- Reads the TOAST pointer only; skips rows already trimmed.
    AND pg_column_size(r.input) > 2048
    AND NOT EXISTS (SELECT 1 FROM "AskScope" s WHERE s."runId" = r.id)
    AND NOT EXISTS (SELECT 1 FROM "RunStep" s WHERE s."runId" = r.id)
)
UPDATE "Run" r
SET input = CASE WHEN r.input->'controlled' IS NOT NULL THEN r.input
  ELSE jsonb_set(r.input, '{scopedQueries}', coalesce((
  SELECT jsonb_agg(q.value ORDER BY q.ordinality)
  FROM jsonb_array_elements(r.input->'scopedQueries') WITH ORDINALITY AS q(value, ordinality)
  WHERE r.progress->'discoveryScope'->>'kind' = 'query'
    AND q.value->>'key' = r.progress->'discoveryScope'->>'key'
), '[]'::jsonb)) END
FROM candidate c
WHERE r.id = c.id;--> statement-breakpoint

-- Progress-only writes skip the admission function and never detoast input.
DROP TRIGGER "Run_guard_mail_discovery_admission" ON "Run";--> statement-breakpoint
CREATE OR REPLACE FUNCTION cubby_guard_mail_discovery_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mailbox text;
  resource text;
  old_resource text;
  waiting boolean;
  active_count integer;
  resource_busy boolean;
BEGIN
  waiting := coalesce(NEW.status = 'paused' AND NEW."failureCode" IN ('mail_discovery_queued', 'controlled_mail_queued'), false);
  IF NEW.purpose <> 'mail_discovery' OR (NEW.status <> 'running' AND NOT waiting) THEN RETURN NEW; END IF;
  mailbox := NEW.input->>'mailboxId';
  IF NEW."ledgerPartyId" IS NULL OR mailbox IS NULL OR mailbox = '' THEN
    RAISE EXCEPTION 'Mail discovery requires a member and stable mailbox';
  END IF;
  resource := CASE WHEN NEW.input->'controlled' IS NULL AND NEW.progress->'discoveryScope'->>'kind' = 'query'
    THEN NULLIF(NEW.progress->'discoveryScope'->>'key', '') END;
  IF TG_OP = 'UPDATE' THEN
    old_resource := CASE WHEN OLD.input->'controlled' IS NULL AND OLD.progress->'discoveryScope'->>'kind' = 'query'
      THEN NULLIF(OLD.progress->'discoveryScope'->>'key', '') END;
    IF OLD.purpose = NEW.purpose AND OLD.status = NEW.status
      AND OLD."ledgerPartyId" = NEW."ledgerPartyId" AND OLD.input->>'mailboxId' = mailbox
      AND old_resource IS NOT DISTINCT FROM resource
      AND (NOT waiting OR (OLD."failureCode" = NEW."failureCode"
        AND OLD.progress->>'attempt' IS NOT DISTINCT FROM NEW.progress->>'attempt'
        AND OLD.progress->>'admissionRequestedAt' IS NOT DISTINCT FROM NEW.progress->>'admissionRequestedAt'))
    THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cubby-mail-discovery:' || NEW."ledgerPartyId"::text || ':' || mailbox, 0));
  -- A changed row version refuses an admission made from an older snapshot.
  -- This write follows the Run lock, matching coverage publication's order.
  INSERT INTO "MailboxCursor" ("ledgerPartyId", provider, "mailboxId", "admissionVersion")
    VALUES (NEW."ledgerPartyId", 'gmail', mailbox, 1)
    ON CONFLICT ("ledgerPartyId", provider, "mailboxId") DO UPDATE
    SET "admissionVersion" = "MailboxCursor"."admissionVersion" + 1;
  IF waiting THEN RETURN NEW; END IF;
  -- includes-deleted: an active legacy writer still occupies capacity until it stops.
  -- The mailbox expression matches "Run_one_active_mail_discovery", so the
  -- count reads index keys instead of detoasting each running Run's input.
  SELECT count(*), coalesce(bool_or(resource IS NULL OR r.input->'controlled' IS NOT NULL OR r.progress->'discoveryScope'->>'kind' IS DISTINCT FROM 'query'
        OR NULLIF(r.progress->'discoveryScope'->>'key', '') IS NULL
        OR r.progress->'discoveryScope'->>'key' = resource), false)
    INTO active_count, resource_busy FROM "Run" r
    WHERE r.id <> NEW.id AND r.purpose = 'mail_discovery' AND r.status = 'running'
      AND r."ledgerPartyId" = NEW."ledgerPartyId" AND COALESCE(r.input->>'mailboxId', '') = mailbox;
  IF active_count >= 4 OR resource_busy THEN
    RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'Run_one_active_mail_discovery',
      MESSAGE = 'Mail discovery admission is occupied';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "Run_guard_mail_discovery_admission"
BEFORE INSERT OR UPDATE OF purpose, "ledgerPartyId", input ON "Run"
FOR EACH ROW WHEN (NEW.purpose = 'mail_discovery')
EXECUTE FUNCTION cubby_guard_mail_discovery_admission();--> statement-breakpoint
CREATE TRIGGER "Run_guard_mail_discovery_state"
BEFORE UPDATE OF status, progress, "failureCode" ON "Run"
FOR EACH ROW WHEN (NEW.purpose = 'mail_discovery' AND (OLD.status IS DISTINCT FROM NEW.status
  OR OLD."failureCode" IS DISTINCT FROM NEW."failureCode"
  OR OLD.progress->'discoveryScope' IS DISTINCT FROM NEW.progress->'discoveryScope'
  OR OLD.progress->>'attempt' IS DISTINCT FROM NEW.progress->>'attempt'
  OR OLD.progress->>'admissionRequestedAt' IS DISTINCT FROM NEW.progress->>'admissionRequestedAt'))
EXECUTE FUNCTION cubby_guard_mail_discovery_admission();

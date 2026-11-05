-- One Suggestion table replaces Assessment, AssessmentState and Feedback for the
-- review families. The three old tables move to the archive schema unchanged and
-- are never dropped. Carried rows keep their old id, so stored handles resolve.
-- Any preservation mismatch aborts this transaction, and so the deployment.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS "AuditLog_derived_mark" ON "AuditLog";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "DerivedValue_derived_mark" ON "DerivedValue";
--> statement-breakpoint
LOCK TABLE "Run" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "LedgerParty" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "AiEvaluation" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "Assessment" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "AssessmentState" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "Feedback" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "Suggestion" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicationKey" text NOT NULL,
  "family" text NOT NULL,
  "subject" jsonb NOT NULL,
  "judgment" jsonb NOT NULL,
  "producer" jsonb,
  "evidence" jsonb,
  "served" boolean DEFAULT true NOT NULL,
  "decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "runId" uuid,
  "ledgerPartyId" uuid,
  "entity" text NOT NULL,
  "recordId" uuid NOT NULL,
  "field" text DEFAULT '' NOT NULL,
  "financeReviewFingerprint" text,
  "evaluationId" uuid,
  "provenance" jsonb,
  "acceptanceReceipt" jsonb,
  "supersessionReceipt" jsonb,
  "currentValue" jsonb,
  "suggestedValue" jsonb DEFAULT 'null'::jsonb NOT NULL,
  "confidence" real DEFAULT 0 NOT NULL,
  "runnerUpValue" jsonb,
  "runnerUpConfidence" real,
  "model" text DEFAULT 'unknown' NOT NULL,
  "kind" text DEFAULT 'addition' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "correctValue" jsonb,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "fingerprint" text,
  "confirmedValue" jsonb,
  "suppression" jsonb,
  "active" boolean DEFAULT true NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "Suggestion_kind_check" CHECK ("Suggestion"."kind" IN ('correction', 'addition')),
  CONSTRAINT "Suggestion_status_check" CHECK ("Suggestion"."status" IN ('pending', 'applied', 'rejected', 'superseded', 'resolved')),
  CONSTRAINT "Suggestion_confidence_check" CHECK ("Suggestion"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id");
--> statement-breakpoint
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_evaluationId_AiEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES "public"."AiEvaluation"("id");
--> statement-breakpoint
-- Everything a member or an automatic application recorded. Projection events
-- only replayed State, which is now the row itself.
CREATE TEMP TABLE "suggestion_retained_event" ON COMMIT DROP AS
SELECT f.id, f."assessmentId", f."createdAt",
  jsonb_build_object(
    'id', f.id, 'operationId', f."operationId", 'verdict', f.verdict,
    'correction', f.correction, 'reason', f.reason, 'evidence', f.evidence,
    'intent', f.intent, 'authority', f.authority, 'actorUserId', f."actorUserId",
    'suppression', f.suppression, 'receipt', f.receipt, 'metadata', f.metadata,
    'createdAt', to_char(f."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) AS event
FROM "Feedback" f
JOIN "Assessment" a ON a.id = f."assessmentId"
WHERE a.family IN ('field', 'statement_transaction', 'transfer_pair', 'recommendation', 'product_pair', 'image_description')
  AND f.intent <> 'projection' AND f.authority <> 'system';
--> statement-breakpoint
CREATE TEMP TABLE "suggestion_carried" ON COMMIT DROP AS
SELECT s.id FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
WHERE s.family IN ('field', 'statement_transaction', 'transfer_pair', 'recommendation', 'product_pair', 'image_description')
  AND (
    -- A decision, suppression, confirmation or receipt carries in any family.
    EXISTS (SELECT 1 FROM "suggestion_retained_event" e WHERE e."assessmentId" = s.id)
    OR s.suppression IS NOT NULL OR s."confirmedValue" IS NOT NULL OR s."correctValue" IS NOT NULL
    OR s."acceptanceReceipt" IS NOT NULL OR s.status IN ('applied', 'rejected')
    -- Queued evaluations, photo groups and settled answers name these by id.
    OR s.family IN ('field', 'product_pair', 'transfer_pair', 'image_description')
    OR (s.family = 'statement_transaction' AND s.active)
    -- Over 97% of these two connection relations were stale in a 200-row sample;
    -- none was ever applied, and a changed input is what re-admits discovery.
    OR (s.family = 'recommendation' AND s.active
      AND a.subject->>'scope' NOT IN ('connection.transaction-purchase', 'connection.transaction-refund'))
  )
UNION
-- A rule re-run reuses paid labels from the newest revision of its charge.
SELECT id FROM (
  SELECT s.id, row_number() OVER (PARTITION BY s.data->>'source', s.data->>'chargeKey' ORDER BY s."createdAt" DESC, s.id DESC) AS position
  FROM "AssessmentState" s WHERE s.family = 'statement_transaction'
) newest WHERE position = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX ON "suggestion_carried" (id);
--> statement-breakpoint
CREATE INDEX ON "suggestion_retained_event" ("assessmentId");
--> statement-breakpoint
INSERT INTO "Suggestion" (
  id, "publicationKey", family, subject, judgment, producer, evidence, served, decisions,
  "runId", "ledgerPartyId", entity, "recordId", field, "financeReviewFingerprint", "evaluationId",
  provenance, "acceptanceReceipt", "supersessionReceipt", "currentValue", "suggestedValue",
  confidence, "runnerUpValue", "runnerUpConfidence", model, kind, status, "correctValue", data,
  fingerprint, "confirmedValue", suppression, active, "createdAt", "updatedAt"
)
SELECT a.id, a."publicationKey", a.family, a.subject, a.judgment, a.producer,
  -- Freshness hashes the current basis against the fingerprint; it never read the stored one.
  -- One read of each wide value: every further reference detoasts it again.
  CASE WHEN a.subject->>'scope' LIKE 'connection.%' THEN a.evidence - 'basis' ELSE a.evidence END,
  a.served,
  coalesce((SELECT jsonb_agg(e.event ORDER BY e."createdAt", e.id) FROM "suggestion_retained_event" e WHERE e."assessmentId" = a.id), '[]'::jsonb),
  s."runId", s."ledgerPartyId", s.entity, s."recordId", s.field, s."financeReviewFingerprint", s."evaluationId",
  s.provenance, s."acceptanceReceipt", s."supersessionReceipt", s."currentValue", s."suggestedValue",
  s.confidence, s."runnerUpValue", s."runnerUpConfidence", s.model, s.kind, s.status, s."correctValue", s.data,
  s.fingerprint, s."confirmedValue", s.suppression, s.active, a."createdAt", s."updatedAt"
FROM "suggestion_carried" c
JOIN "AssessmentState" s ON s.id = c.id
JOIN "Assessment" a ON a.id = c.id;
--> statement-breakpoint
DO $preserve$
DECLARE
  difference bigint;
  unaccounted text;
BEGIN
  -- Every carried row, column by column, including nulls.
  SELECT count(*) INTO difference FROM (
    (SELECT md5(ROW(a.id, a."publicationKey", a.family, a.subject, a.judgment, a.producer,
        CASE WHEN a.subject->>'scope' LIKE 'connection.%' THEN a.evidence - 'basis' ELSE a.evidence END,
        a.served, s."runId", s."ledgerPartyId", s.entity, s."recordId", s.field, s."financeReviewFingerprint",
        s."evaluationId", s.provenance, s."acceptanceReceipt", s."supersessionReceipt", s."currentValue", s."suggestedValue",
        s.confidence, s."runnerUpValue", s."runnerUpConfidence", s.model, s.kind, s.status, s."correctValue", s.data,
        s.fingerprint, s."confirmedValue", s.suppression, s.active, a."createdAt", s."updatedAt")::text) AS h
      FROM "suggestion_carried" c JOIN "AssessmentState" s ON s.id = c.id JOIN "Assessment" a ON a.id = c.id
    EXCEPT ALL
    SELECT md5(ROW(n.id, n."publicationKey", n.family, n.subject, n.judgment, n.producer,
        n.evidence,
        n.served, n."runId", n."ledgerPartyId", n.entity, n."recordId", n.field, n."financeReviewFingerprint",
        n."evaluationId", n.provenance, n."acceptanceReceipt", n."supersessionReceipt", n."currentValue", n."suggestedValue",
        n.confidence, n."runnerUpValue", n."runnerUpConfidence", n.model, n.kind, n.status, n."correctValue", n.data,
        n.fingerprint, n."confirmedValue", n.suppression, n.active, n."createdAt", n."updatedAt")::text)
      FROM "Suggestion" n)
  ) missing;
  IF difference <> 0 OR (SELECT count(*) FROM "Suggestion") <> (SELECT count(*) FROM "suggestion_carried") THEN
    RAISE EXCEPTION 'Suggestion rows differ from their source (% missing)', difference;
  END IF;
  -- Every retained event, whole, on the Suggestion it was recorded on.
  SELECT count(*) INTO difference FROM (
    (SELECT e."assessmentId", e.event FROM "suggestion_retained_event" e
     EXCEPT ALL
     SELECT n.id, d.event FROM "Suggestion" n CROSS JOIN LATERAL jsonb_array_elements(n.decisions) d(event))
    UNION ALL
    (SELECT n.id, d.event FROM "Suggestion" n CROSS JOIN LATERAL jsonb_array_elements(n.decisions) d(event)
     EXCEPT ALL
     SELECT e."assessmentId", e.event FROM "suggestion_retained_event" e)
  ) changed;
  IF difference <> 0 THEN
    RAISE EXCEPTION 'Suggestion decisions differ from Feedback (% events)', difference;
  END IF;
  -- Each Feedback event is carried, or is one of the named exclusions.
  SELECT string_agg(DISTINCT a.family || '/' || f.authority || '/' || f.intent, ', ') INTO unaccounted
  FROM "Feedback" f JOIN "Assessment" a ON a.id = f."assessmentId"
  WHERE NOT EXISTS (SELECT 1 FROM "suggestion_retained_event" e WHERE e.id = f.id)
    AND f.intent <> 'projection' AND f.authority <> 'system'
    -- These families moved to their domain owners before this migration.
    AND a.family NOT IN ('email_link', 'email_relevance', 'mail_import_outcome', 'run_finding');
  IF unaccounted IS NOT NULL THEN
    RAISE EXCEPTION 'Unaccounted Feedback categories: %', unaccounted;
  END IF;
  -- Member corrections, suppressions and confirmations survive by construction above; check them directly.
  IF EXISTS (SELECT 1 FROM "AssessmentState" s
      WHERE (s.suppression IS NOT NULL OR s."confirmedValue" IS NOT NULL OR s."acceptanceReceipt" IS NOT NULL)
        AND s.family NOT IN ('email_link', 'email_relevance', 'mail_import_outcome', 'run_finding')
        AND NOT EXISTS (SELECT 1 FROM "Suggestion" n WHERE n.id = s.id)) THEN
    RAISE EXCEPTION 'A suppression, confirmation or acceptance receipt was not carried';
  END IF;
END $preserve$;
--> statement-breakpoint
ALTER TABLE "AssessmentReadDependency" DROP CONSTRAINT IF EXISTS "AssessmentReadDependency_assessmentId_Assessment_id_fk";
--> statement-breakpoint
ALTER TABLE "AssessmentReadMembership" DROP CONSTRAINT IF EXISTS "AssessmentReadMembership_assessmentId_Assessment_id_fk";
--> statement-breakpoint
ALTER TABLE "AssessmentReadPublication" DROP CONSTRAINT IF EXISTS "AssessmentReadPublication_assessmentId_Assessment_id_fk";
--> statement-breakpoint
DO $archive$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT conrelid::regclass AS owner, conname FROM pg_constraint
    WHERE contype = 'f' AND conrelid IN ('"Assessment"'::regclass, '"AssessmentState"'::regclass, '"Feedback"'::regclass)
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', target.owner, target.conname); END LOOP;
  FOR target IN
    SELECT tgrelid::regclass AS owner, tgname FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid IN ('"Assessment"'::regclass, '"AssessmentState"'::regclass, '"Feedback"'::regclass)
  LOOP EXECUTE format('DROP TRIGGER %I ON %s', target.tgname, target.owner); END LOOP;
  FOR target IN
    SELECT indexrelid::regclass AS name FROM pg_index
    WHERE NOT indisprimary AND indrelid IN ('"Assessment"'::regclass, '"AssessmentState"'::regclass, '"Feedback"'::regclass)
  LOOP EXECUTE format('DROP INDEX %s', target.name); END LOOP;
END $archive$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "archive";
--> statement-breakpoint
ALTER TABLE "Assessment" SET SCHEMA "archive";
--> statement-breakpoint
ALTER TABLE "AssessmentState" SET SCHEMA "archive";
--> statement-breakpoint
ALTER TABLE "Feedback" SET SCHEMA "archive";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "feedback_retired_family_refused"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS derived_mark_assessment();
--> statement-breakpoint
DROP FUNCTION IF EXISTS derived_mark_assessmentstate();
--> statement-breakpoint
DROP FUNCTION IF EXISTS derived_mark_auditlog();
--> statement-breakpoint
DROP FUNCTION IF EXISTS derived_mark_derivedvalue();
--> statement-breakpoint
DROP FUNCTION IF EXISTS derived_mark_feedback();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "assessment_retired_family_refused"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "feedback_retired_family_refused"();
--> statement-breakpoint
CREATE UNIQUE INDEX "Suggestion_publication_key" ON "Suggestion" USING btree ("publicationKey");
--> statement-breakpoint
CREATE INDEX "Suggestion_family_active_idx" ON "Suggestion" USING btree ("family", "active", "status");
--> statement-breakpoint
CREATE INDEX "Suggestion_run_status_idx" ON "Suggestion" USING btree ("runId", "status");
--> statement-breakpoint
CREATE INDEX "Suggestion_active_suppression_idx" ON "Suggestion" USING btree ("entity", "recordId") WHERE "Suggestion"."active" AND "Suggestion"."suppression" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "Suggestion_ledger_party_idx" ON "Suggestion" USING btree ("ledgerPartyId", "family", "status");
--> statement-breakpoint
CREATE INDEX "Suggestion_evaluation_idx" ON "Suggestion" USING btree ("evaluationId");
--> statement-breakpoint
CREATE INDEX "Suggestion_entity_field_status_idx" ON "Suggestion" USING btree ("entity", "field", "status");
--> statement-breakpoint
CREATE INDEX "Suggestion_entity_record_status_idx" ON "Suggestion" USING btree ("entity", "recordId", "status");
--> statement-breakpoint
CREATE INDEX "Suggestion_active_value_status_idx" ON "Suggestion" USING btree ("status", md5("suggestedValue" #>> '{}')) WHERE "Suggestion"."active";
--> statement-breakpoint
CREATE INDEX "Suggestion_served_other_id_idx" ON "Suggestion" USING btree (md5("subject"->>'otherId')) WHERE "Suggestion"."served" AND ("Suggestion"."subject"->>'otherId') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "Suggestion_served_source_ref_idx" ON "Suggestion" USING btree (md5("judgment" #>> '{create,sourceRef,source}'), md5("judgment" #>> '{create,sourceRef,externalId}')) WHERE "Suggestion"."served" AND ("Suggestion"."judgment" #>> '{create,sourceRef,source}') IS NOT NULL AND ("Suggestion"."judgment" #>> '{create,sourceRef,externalId}') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "Suggestion_reference_records_idx" ON "Suggestion" USING gin (("evidence"->'records')) WHERE "Suggestion"."served";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Suggestion_connection_source_ref_idx" ON "Suggestion"
 ((evidence #>> '{candidate,source,entityKind}'), (evidence #>> '{candidate,source,entityId}')) INCLUDE (id)
 WHERE served AND subject->>'scope' LIKE 'connection.%';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Suggestion_connection_target_ref_idx" ON "Suggestion"
 ((evidence #>> '{candidate,target,entityKind}'), (evidence #>> '{candidate,target,entityId}')) INCLUDE (id)
 WHERE served AND subject->>'scope' LIKE 'connection.%';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Suggestion_statement_charge_key" ON "Suggestion" ((data->>'source'),(data->>'chargeKey')) WHERE family='statement_transaction' AND active;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Suggestion_statement_charge_history_idx" ON "Suggestion" ((data->>'source'),(data->>'chargeKey'),"createdAt" DESC,id DESC) WHERE family='statement_transaction';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Suggestion_statement_refs_idx" ON "Suggestion" USING gin ((data->'refs')) WHERE family='statement_transaction' AND active AND status='pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Suggestion_statement_account_idx" ON "Suggestion" ((data->>'accountId'),(data->>'month')) WHERE family='statement_transaction' AND active AND status='pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Suggestion_statement_label_native_idx" ON "Suggestion" ("createdAt",id) WHERE family='statement_transaction' AND active AND status='pending' AND ((data->>'needsLabel')::boolean OR coalesce((data->>'applicationPending')::boolean,false)) AND (data->'applicationOrder'->>'createdAt' IS NULL AND data->'applicationOrder'->>'id' IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Suggestion_statement_label_receipt_idx" ON "Suggestion" (id) WHERE family='statement_transaction' AND active AND status='pending' AND ((data->>'needsLabel')::boolean OR coalesce((data->>'applicationPending')::boolean,false)) AND NOT (data->'applicationOrder'->>'createdAt' IS NULL AND data->'applicationOrder'->>'id' IS NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_aianalysis() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('product.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('product.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('recipe.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('recipe.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('ingredient.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('ingredient.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('cookbook.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('cookbook.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('location.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('location.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' AND NEW."feature" = 'location-description' THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' AND OLD."feature" = 'location-description' THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' AND OLD."feature" = 'location-description' OR NEW."entityKind" = 'location' AND NEW."feature" = 'location-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' AND NEW."feature" = 'location-description' THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' AND OLD."feature" = 'location-description' THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' AND OLD."feature" = 'location-description' OR NEW."entityKind" = 'location' AND NEW."feature" = 'location-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('inventory.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('inventory.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('meal.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('meal.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@0', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@0', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ai analysis removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@0', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('project.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('project.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('task.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('task.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('vendor.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('vendor.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('purchase.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('purchase.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('financialAccount.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('financialAccount.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('wish.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('wish.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('expense.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('expense.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('planting.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('planting.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('plant.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('plant.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_cookbook() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Cookbook changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[NEW."id"::uuid], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."id"::uuid], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Cookbook changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."id"::uuid], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."id"::uuid], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Cookbook changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Cookbook changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_device() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Device created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Device removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Device changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@3', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Device created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@3', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Device removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@3', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Device changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality', ARRAY[NEW."id"::uuid], 'Device created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality', ARRAY[OLD."id"::uuid], 'Device removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('device.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Device changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_email() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@4', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@4', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@4', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@4', ARRAY[NEW."id"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@4', ARRAY[OLD."id"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@36', ARRAY[NEW."ledgerPartyId"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@36', ARRAY[OLD."ledgerPartyId"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@36', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@14', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."provider", OLD."mailboxId", OLD."messageId", OLD."orderMailId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."provider", NEW."mailboxId", NEW."messageId", NEW."orderMailId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.beneficiaryResult@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts', ARRAY[NEW."id"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts', ARRAY[OLD."id"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."ledgerPartyId", OLD."provider", OLD."mailboxId", OLD."messageId", OLD."receivedAt", OLD."checksum", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."ledgerPartyId", NEW."provider", NEW."mailboxId", NEW."messageId", NEW."receivedAt", NEW."checksum", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."id"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."id"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Email changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_emailpurchasedecision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@11', ARRAY[NEW."purchaseId"::uuid], 'Email purchase decision created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@11', ARRAY[OLD."purchaseId"::uuid], 'Email purchase decision removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@11', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Email purchase decision changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY[NEW."purchaseId"::uuid], 'Email purchase decision created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY[OLD."purchaseId"::uuid], 'Email purchase decision removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."eventId", OLD."decision", OLD."evidenceChecksum", OLD."proposedBy", OLD."active") IS DISTINCT FROM (NEW."purchaseId", NEW."eventId", NEW."decision", NEW."evidenceChecksum", NEW."proposedBy", NEW."active") THEN
    PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Email purchase decision changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@4', ARRAY[NEW."eventId"::uuid], 'Email purchase decision created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@4', ARRAY[OLD."eventId"::uuid], 'Email purchase decision removed'); END IF;
  ELSIF (true OR true) AND (OLD."eventId", OLD."purchaseId", OLD."decision", OLD."evidenceChecksum", OLD."proposedBy", OLD."active") IS DISTINCT FROM (NEW."eventId", NEW."purchaseId", NEW."decision", NEW."evidenceChecksum", NEW."proposedBy", NEW."active") THEN
    PERFORM derived_mark('email.relationshipFacts@4', ARRAY[OLD."eventId"::uuid] || ARRAY[NEW."eventId"::uuid], 'Email purchase decision changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@6', ARRAY[NEW."eventId"::uuid], 'Email purchase decision created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@6', ARRAY[OLD."eventId"::uuid], 'Email purchase decision removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@6', ARRAY[OLD."eventId"::uuid] || ARRAY[NEW."eventId"::uuid], 'Email purchase decision changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@50', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@50', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."kind", OLD."shortcode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."kind", NEW."shortcode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.workDiagnosticFacts@50', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entityattachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('product.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('recipe.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('location.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('location.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('meal.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ledgerParty' OR NEW."entityKind" = 'ledgerParty') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ledgerTransfer' OR NEW."entityKind" = 'ledgerTransfer') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@24', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@24', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@24', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@28', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@28', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@28', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@32', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@32', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@32', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@11', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@11', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@11', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@15', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@15', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@15', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@19', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@19', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@19', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@23', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@23', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@23', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@27', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@27', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@27', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@31', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@31', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@31', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@35', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@35', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@35', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@39', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@39', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@39', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@45', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@45', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@45', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@48', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@48', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@48', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@52', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@52', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@52', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@56', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@56', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@56', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@60', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@60', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@60', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@64', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@64', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@64', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@68', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@68', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@68', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@72', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@72', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@72', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@76', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@76', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@76', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@15', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@15', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@15', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@18', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@18', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@18', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@22', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@22', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@22', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('wish.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@10', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@10', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('wish.dataQuality@10', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@24', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@24', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@24', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."imageId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid] || ARRAY[NEW."imageId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@13', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@13', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@13', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'productCategory' OR NEW."entityKind" = 'productCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'run' OR NEW."entityKind" = 'run') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('run.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'device' OR NEW."entityKind" = 'device') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('device.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('device.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@10', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@10', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@10', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@14', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@14', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@14', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'spendingCategory' OR NEW."entityKind" = 'spendingCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'email' OR NEW."entityKind" = 'email') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'imageJob' OR NEW."entityKind" = 'imageJob') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'sourceTransactionRecord' OR NEW."entityKind" = 'sourceTransactionRecord') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'transactionImport' THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'transactionImport' THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'transactionImport' OR NEW."entityKind" = 'transactionImport') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entityexternalid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.food', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.food', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.food', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('recipe.totals@0', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('recipe.totals@0', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@0', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@12', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@12', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entitylink() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@21', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@21', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@21', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@28', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@28', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@28', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@12', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@12', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@12', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@3', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@3', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@3', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@6', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@6', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@6', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@13', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@13', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@13', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@18', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@18', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@18', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('project.dataQuality@18', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('project.dataQuality@18', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('project.dataQuality@18', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@25', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@25', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('task.dataQuality@25', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@62', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@62', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('task.dataQuality@62', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchasePaymentAccount' OR NEW."kind" = 'purchasePaymentAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.dataQuality@4', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.dataQuality@4', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('wish.dataQuality@4', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('planting.dataQuality@4', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('planting.dataQuality@4', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (OLD."toEntityId", OLD."deletedAt", OLD."fromEntityId", OLD."kind") IS DISTINCT FROM (NEW."toEntityId", NEW."deletedAt", NEW."fromEntityId", NEW."kind") THEN
    PERFORM derived_mark('planting.dataQuality@4', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('plant.dataQuality@8', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('plant.dataQuality@8', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (OLD."toEntityId", OLD."deletedAt", OLD."fromEntityId", OLD."kind") IS DISTINCT FROM (NEW."toEntityId", NEW."deletedAt", NEW."fromEntityId", NEW."kind") THEN
    PERFORM derived_mark('plant.dataQuality@8', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_expense() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@20', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@20', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@20', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@27', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@27', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@27', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@4', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@4', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@4', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@11', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@11', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@11', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@7', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@7', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@7', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@23', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@23', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@23', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@3', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@3', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@3', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@5', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@5', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@5', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@12', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@12', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@12', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."cost", OLD."future", OLD."lineKind", OLD."date", OLD."purchaseId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."cost", NEW."future", NEW."lineKind", NEW."date", NEW."purchaseId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@12', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@12', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@12', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@14', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@14', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('project.dataQuality@14', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@21', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@21', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('task.dataQuality@21', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@58', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@58', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('task.dataQuality@58', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('purchase.dataQuality@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."cost", OLD."future", OLD."purchaseId", OLD."deletedAt", OLD."name") IS DISTINCT FROM (NEW."id", NEW."cost", NEW."future", NEW."purchaseId", NEW."deletedAt", NEW."name") THEN
    PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."cost", OLD."lineKind", OLD."productId", OLD."projectId", OLD."spendingCategoryId", OLD."trade", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."purchaseId", NEW."cost", NEW."lineKind", NEW."productId", NEW."projectId", NEW."spendingCategoryId", NEW."trade", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@14', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@14', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('expense.dataQuality@14', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@31', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@31', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."cost", OLD."lineKind", OLD."productId", OLD."projectId", OLD."spendingCategoryId", OLD."trade", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."purchaseId", NEW."cost", NEW."lineKind", NEW."productId", NEW."projectId", NEW."spendingCategoryId", NEW."trade", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@31', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_expenseattribution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@34', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@34', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@34', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@35', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@35', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@35', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@18', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@18', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@18', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@19', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@19', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@19', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@19', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@19', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@19', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@20', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@20', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@20', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@9', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@9', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@9', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_externalsource() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@55', ARRAY[coalesce(NEW."vendorId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'External source created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@55', ARRAY[coalesce(OLD."vendorId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'External source removed'); END IF;
  ELSIF (true OR true) AND (OLD."vendorId", OLD."slug", OLD."issuer") IS DISTINCT FROM (NEW."vendorId", NEW."slug", NEW."issuer") THEN
    PERFORM derived_mark('project.workDiagnosticFacts@55', ARRAY[coalesce(OLD."vendorId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."vendorId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'External source changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialaccount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@25', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@25', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@32', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@32', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@9', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@9', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@16', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@16', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@10', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@10', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@17', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@17', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."ledgerPartyId"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."ledgerPartyId"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@26', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@26', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@27', ARRAY[NEW."providerVendorId"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@27', ARRAY[OLD."providerVendorId"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (OLD."providerVendorId", OLD."identity", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."providerVendorId", NEW."identity", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@27', ARRAY[OLD."providerVendorId"::uuid] || ARRAY[NEW."providerVendorId"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@29', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@29', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialtransaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@24', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@24', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@31', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@31', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@31', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@8', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@8', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@15', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@15', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@9', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@9', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@16', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@16', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."ledgerTransferId"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."ledgerTransferId"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (OLD."ledgerTransferId", OLD."deletedAt", OLD."status") IS DISTINCT FROM (NEW."ledgerTransferId", NEW."deletedAt", NEW."status") THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."ledgerTransferId"::uuid] || ARRAY[NEW."ledgerTransferId"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@25', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@25', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialtransactionallocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@23', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@23', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@23', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@30', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@30', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@30', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@7', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@7', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@7', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@14', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@14', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@14', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@8', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@8', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@8', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@15', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@15', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@15', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (OLD."transactionId", OLD."deletedAt", OLD."purchaseId") IS DISTINCT FROM (NEW."transactionId", NEW."deletedAt", NEW."purchaseId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_gardenentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@13', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@13', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@13', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@5', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@5', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@9', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@9', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_image() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('product.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('product.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('product.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('recipe.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('recipe.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('location.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('location.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('location.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('location.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('inventory.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('meal.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('meal.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('project.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('project.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@25', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@25', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@29', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@29', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@33', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@33', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('task.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('task.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@12', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@12', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@16', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@16', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@20', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@20', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@24', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@24', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@28', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@28', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@32', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@32', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@36', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@36', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@36', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@40', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@40', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@46', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@46', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@46', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@49', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@49', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@49', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@53', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@53', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@53', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@57', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@57', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@57', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@61', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@61', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@61', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@65', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@65', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@65', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@69', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@69', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@69', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@73', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@73', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@73', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@77', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@77', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@77', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('vendor.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('purchase.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@16', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@16', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@19', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@19', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@23', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@23', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('wish.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('wish.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@11', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@11', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('wish.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('expense.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@25', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@25', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('image.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('image.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('planting.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@14', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@14', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('run.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('run.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('device.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('device.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('plant.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@11', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@11', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@15', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@15', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('shipment.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_imagederivative() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@15', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image derivative created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@15', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image derivative removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@15', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image derivative changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_imageprocessingjob() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@54', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image processing job created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@54', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image processing job removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."imageId") IS DISTINCT FROM (NEW."id", NEW."imageId") THEN
    PERFORM derived_mark('project.workDiagnosticFacts@54', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image processing job changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[NEW."id"::uuid], 'Image processing job created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."id"::uuid], 'Image processing job removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image processing job changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_imagesighting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image sighting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image sighting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image sighting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."imageId"::uuid], 'Image sighting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid], 'Image sighting removed'); END IF;
  ELSIF (true OR true) AND (OLD."imageId", OLD."deletedAt") IS DISTINCT FROM (NEW."imageId", NEW."deletedAt") THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid] || ARRAY[NEW."imageId"::uuid], 'Image sighting changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_importsourceclaim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@17', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@17', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@17', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@37', ARRAY[NEW."ledgerPartyId"::uuid], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@37', ARRAY[OLD."ledgerPartyId"::uuid], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@37', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."id", NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."id", NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(NEW."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(OLD."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(OLD."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@7', ARRAY[NEW."ledgerPartyId"::uuid], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@7', ARRAY[OLD."ledgerPartyId"::uuid], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@7', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Import source claim changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_importsourceorder() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@18', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@18', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@18', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId") THEN
    PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(NEW."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(OLD."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId", OLD."checksum") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId", NEW."checksum") THEN
    PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(OLD."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@9', ARRAY[NEW."sourceClaimId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@9', ARRAY[OLD."sourceClaimId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@9', ARRAY[OLD."sourceClaimId"::uuid] || ARRAY[NEW."sourceClaimId"::uuid], 'Import source order changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_importsourceproduct() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@45', ARRAY[NEW."sourceOrderId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@45', ARRAY[OLD."sourceOrderId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@45', ARRAY[OLD."sourceOrderId"::uuid] || ARRAY[NEW."sourceOrderId"::uuid], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[NEW."sourceOrderId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[OLD."sourceOrderId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[OLD."sourceOrderId"::uuid] || ARRAY[NEW."sourceOrderId"::uuid], 'Import source product changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ingredient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@1', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@1', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."naKinds") IS DISTINCT FROM (NEW."id", NEW."naKinds") THEN
    PERFORM derived_mark('product.conversionCoverage@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@1', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@1', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@10', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@10', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@10', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@10', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ingredient changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_inventoryentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."locationId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."locationId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."locationId", OLD."placement", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."locationId", NEW."placement", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."locationId"::uuid] || ARRAY[NEW."locationId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@12', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@12', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@12', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@2', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@2', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership@2', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@21', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Inventory entry changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ledgerparty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@36', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@36', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@36', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@37', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@37', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@37', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@38', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@38', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@38', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@39', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@39', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@39', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@40', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@40', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@41', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@41', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@41', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@42', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@42', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@42', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@20', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@20', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@21', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@21', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@22', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@22', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@23', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@23', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@24', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@24', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@25', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@25', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@26', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@26', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@21', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@21', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@22', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@22', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@23', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@23', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@24', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@24', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@25', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@25', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@26', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@26', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@27', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@27', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@22', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@18', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@18', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."kind", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."kind", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@8', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@8', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@39', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@39', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@39', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@40', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@40', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."kind", OLD."name", OLD."shortcode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."kind", NEW."name", NEW."shortcode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@8', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@8', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ledgertransfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."id"::uuid], 'Ledger transfer created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."id"::uuid], 'Ledger transfer removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger transfer changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@23', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger transfer created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@23', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger transfer removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@23', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger transfer changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@44', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@44', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."parentId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."parentId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."parentId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."parentId"::uuid] || ARRAY[NEW."parentId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@11', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@11', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@7', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@7', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@14', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@14', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productId") THEN
    PERFORM derived_mark('inventory.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@22', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@22', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@24', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@24', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@24', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@9', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@9', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_meal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@5', ARRAY[NEW."id"::uuid], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@5', ARRAY[OLD."id"::uuid], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Meal changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument', ARRAY[NEW."id"::uuid], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."id"::uuid], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Meal changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."id"::uuid], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."id"::uuid], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Meal changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@25', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@25', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@25', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_mealfoodentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Meal food entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Meal food entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Meal food entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."mealId"::uuid], 'Meal food entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."mealId"::uuid], 'Meal food entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."mealId", OLD."deletedAt") IS DISTINCT FROM (NEW."mealId", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."mealId"::uuid] || ARRAY[NEW."mealId"::uuid], 'Meal food entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@26', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal food entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@26', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal food entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@26', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal food entry changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_mealrecipe() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@4', ARRAY[NEW."recipeId"::uuid], 'Meal recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@4', ARRAY[OLD."recipeId"::uuid], 'Meal recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."recipeId", OLD."deletedAt", OLD."mealId") IS DISTINCT FROM (NEW."recipeId", NEW."deletedAt", NEW."mealId") THEN
    PERFORM derived_mark('recipe.dataQuality@4', ARRAY[OLD."recipeId"::uuid] || ARRAY[NEW."recipeId"::uuid], 'Meal recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument', ARRAY[NEW."mealId"::uuid], 'Meal recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."mealId"::uuid], 'Meal recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."mealId"::uuid] || ARRAY[NEW."mealId"::uuid], 'Meal recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@4', ARRAY[NEW."mealId"::uuid], 'Meal recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@4', ARRAY[OLD."mealId"::uuid], 'Meal recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."mealId", OLD."deletedAt", OLD."recipeId") IS DISTINCT FROM (NEW."mealId", NEW."deletedAt", NEW."recipeId") THEN
    PERFORM derived_mark('meal.dataQuality@4', ARRAY[OLD."mealId"::uuid] || ARRAY[NEW."mealId"::uuid], 'Meal recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."mealId"::uuid], 'Meal recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."mealId"::uuid], 'Meal recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."mealId"::uuid] || ARRAY[NEW."mealId"::uuid], 'Meal recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@27', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@27', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@27', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal recipe changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_mealrecipeportion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@28', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal recipe portion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@28', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal recipe portion removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@28', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal recipe portion changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ordermail() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@5', ARRAY[NEW."id"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@5', ARRAY[OLD."id"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@38', ARRAY[NEW."ledgerPartyId"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@38', ARRAY[OLD."ledgerPartyId"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@38', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@11', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId") THEN
    PERFORM derived_mark('expense.beneficiaryResult@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@1', ARRAY[NEW."id"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@1', ARRAY[OLD."id"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."vendorId", OLD."rawChecksum") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."vendorId", NEW."rawChecksum") THEN
    PERFORM derived_mark('email.relationshipFacts@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@15', ARRAY[NEW."id"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@15', ARRAY[OLD."id"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ordermailattachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@7', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@7', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@7', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@42', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@42', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@42', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@12', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."providerAttachmentId") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."providerAttachmentId") THEN
    PERFORM derived_mark('expense.beneficiaryResult@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@3', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@3', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."orderMailId", OLD."providerAttachmentId", OLD."checksum") IS DISTINCT FROM (NEW."orderMailId", NEW."providerAttachmentId", NEW."checksum") THEN
    PERFORM derived_mark('email.relationshipFacts@3', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@16', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@16', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@16', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ordermailevent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@6', ARRAY[NEW."id"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@6', ARRAY[OLD."id"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@41', ARRAY[NEW."orderMailId"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@41', ARRAY[OLD."orderMailId"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@41', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@13', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@13', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."supersededAt") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."supersededAt") THEN
    PERFORM derived_mark('expense.beneficiaryResult@13', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@2', ARRAY[NEW."orderMailId"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@2', ARRAY[OLD."orderMailId"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (OLD."orderMailId", OLD."orderId", OLD."amount", OLD."supersededAt") IS DISTINCT FROM (NEW."orderMailId", NEW."orderId", NEW."amount", NEW."supersededAt") THEN
    PERFORM derived_mark('email.relationshipFacts@2', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@10', ARRAY[NEW."orderMailId"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@10', ARRAY[OLD."orderMailId"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@10', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail event changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_photogroupproposal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Photo group proposal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Photo group proposal removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."state") IS DISTINCT FROM (NEW."productId", NEW."state") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Photo group proposal changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@29', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo group proposal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@29', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo group proposal removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@29', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo group proposal changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_photogroupsourceevidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@30', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo group source evidence created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@30', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo group source evidence removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@30', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo group source evidence changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_photorunimage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@31', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo run image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@31', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo run image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@31', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Photo run image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."runId"::uuid], 'Photo run image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."runId"::uuid], 'Photo run image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."runId"::uuid] || ARRAY[NEW."runId"::uuid], 'Photo run image changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_plant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@32', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@32', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@32', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@8', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@8', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@9', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@9', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."gardenGuideKey", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."gardenGuideKey", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_planting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."sourceProductId"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."sourceProductId"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (OLD."sourceProductId", OLD."deletedAt") IS DISTINCT FROM (NEW."sourceProductId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."sourceProductId"::uuid] || ARRAY[NEW."sourceProductId"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@33', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@33', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@33', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument', ARRAY[NEW."id"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."id"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality', ARRAY[NEW."id"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."id"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@8', ARRAY[NEW."id"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@8', ARRAY[OLD."id"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."plantId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."plantId", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@7', ARRAY[NEW."plantId"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@7', ARRAY[OLD."plantId"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (OLD."plantId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."plantId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('plant.dataQuality@7', ARRAY[OLD."plantId"::uuid] || ARRAY[NEW."plantId"::uuid], 'Planting changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_product() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."stockTracked", OLD."categoryId") IS DISTINCT FROM (NEW."id", NEW."stockTracked", NEW."categoryId") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.food', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.food', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."fdc_id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."fdc_id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.food', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."name", OLD."shortcode", OLD."categoryId", OLD."fdc_id", OLD."labelNutrition", OLD."usdaUnavailable", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."ingredientId", NEW."name", NEW."shortcode", NEW."categoryId", NEW."fdc_id", NEW."labelNutrition", NEW."usdaUnavailable", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."ingredientId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."ingredientId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@1', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@1', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('location.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@1', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@1', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@10', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@10', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('inventory.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@18', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@18', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('inventory.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@19', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@19', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@30', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@30', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@12', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@12', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@13', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@13', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@18', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@18', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@29', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@29', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@33', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@33', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@37', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@37', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@37', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@44', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@44', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@50', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@50', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@50', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@55', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@55', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@55', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@59', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@59', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@59', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@63', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@63', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@63', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@66', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@66', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@66', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@70', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@70', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@70', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@74', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@74', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@74', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@14', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@14', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@20', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@20', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('purchase.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@34', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@34', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."categoryId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."categoryId") THEN
    PERFORM derived_mark('purchase.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."model", OLD."brandId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."model", NEW."brandId", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('wish.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@10', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@10', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('expense.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('expense.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@35', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@35', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('planting.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[NEW."categoryId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[OLD."categoryId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."categoryId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."categoryId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[OLD."categoryId"::uuid] || ARRAY[NEW."categoryId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[NEW."categoryId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[OLD."categoryId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."categoryId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."categoryId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[OLD."categoryId"::uuid] || ARRAY[NEW."categoryId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('device.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@4', ARRAY[NEW."growsPlantId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@4', ARRAY[OLD."growsPlantId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."growsPlantId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."growsPlantId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('plant.dataQuality@4', ARRAY[OLD."growsPlantId"::uuid] || ARRAY[NEW."growsPlantId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@12', ARRAY[NEW."growsPlantId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@12', ARRAY[OLD."growsPlantId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."growsPlantId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."growsPlantId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('plant.dataQuality@12', ARRAY[OLD."growsPlantId"::uuid] || ARRAY[NEW."growsPlantId"::uuid], 'Product changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@15', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@15', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."stockTracked", OLD."parentId", OLD."name", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."stockTracked", NEW."parentId", NEW."name", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@3', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@3', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@10', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@10', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@28', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@28', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@10', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@10', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@35', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@35', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@27', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@27', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productconversioncoverage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@51', ARRAY[coalesce(NEW."productId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product conversion coverage created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@51', ARRAY[coalesce(OLD."productId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product conversion coverage removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@51', ARRAY[coalesce(OLD."productId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."productId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product conversion coverage changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productunitmapping() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."productId"::uuid], 'Product unit mapping created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid], 'Product unit mapping removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Product unit mapping changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@7', ARRAY[NEW."productId"::uuid], 'Product unit mapping created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@7', ARRAY[OLD."productId"::uuid], 'Product unit mapping removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@7', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Product unit mapping changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@10', ARRAY[NEW."productId"::uuid], 'Product unit mapping created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@10', ARRAY[OLD."productId"::uuid], 'Product unit mapping removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@10', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Product unit mapping changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@36', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product unit mapping created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@36', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product unit mapping removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@36', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product unit mapping changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."startDate", OLD."endDate", OLD."status", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."startDate", NEW."endDate", NEW."status", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."parentProjectId"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."parentProjectId"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."parentProjectId"::uuid] || ARRAY[NEW."parentProjectId"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."startDate", OLD."endDate", OLD."status", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."startDate", NEW."endDate", NEW."status", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."parentProjectId"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."parentProjectId"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."parentProjectId"::uuid] || ARRAY[NEW."parentProjectId"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@37', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@37', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@37', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."startDate", OLD."endDate", OLD."status", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."startDate", NEW."endDate", NEW."status", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."parentProjectId"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."parentProjectId"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."parentProjectId"::uuid] || ARRAY[NEW."parentProjectId"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."costEstimate", OLD."deletedAt", OLD."parentProjectId") IS DISTINCT FROM (NEW."id", NEW."costEstimate", NEW."deletedAt", NEW."parentProjectId") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@15', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@15', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@16', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@16', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@17', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@17', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@23', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@23', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('project.rollups@23', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@9', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@9', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@10', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@10', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@10', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@10', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@42', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@42', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."defaultTrade", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."defaultTrade", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@42', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@43', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@43', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."defaultTrade", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."defaultTrade", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@43', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@47', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@47', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@47', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@14', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@14', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@15', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@15', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@16', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@16', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@32', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@32', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."defaultTrade", OLD."parentProjectId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."defaultTrade", NEW."parentProjectId") THEN
    PERFORM derived_mark('expense.dataQuality@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@33', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@33', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."defaultTrade", OLD."parentProjectId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."defaultTrade", NEW."parentProjectId") THEN
    PERFORM derived_mark('expense.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_purchase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@19', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@19', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@26', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@26', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@3', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@3', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@10', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@10', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@18', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@18', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@19', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@19', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@11', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@11', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@38', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@38', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@38', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@14', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@14', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@5', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@5', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@4', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@4', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@4', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@5', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@5', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."vendorId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."vendorId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."vendorId"::uuid] || ARRAY[NEW."vendorId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."vendorId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."vendorId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@17', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@17', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@7', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@7', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@18', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@18', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."vendorId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."vendorId") THEN
    PERFORM derived_mark('expense.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@34', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@34', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderId", OLD."vendorId", OLD."vendorAccountId", OLD."statedTotal", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderId", NEW."vendorId", NEW."vendorAccountId", NEW."statedTotal", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorAccountId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorAccountId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@11', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@11', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_purchasepaymentevidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@39', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase payment evidence created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@39', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase payment evidence removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@39', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase payment evidence changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Purchase payment evidence created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Purchase payment evidence removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Purchase payment evidence changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_recipe() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt', 'totals', 'totalsComputedAt', 'totalsPublishedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt', 'totals', 'totalsComputedAt', 'totalsPublishedAt']) THEN
    PERFORM derived_mark('recipe.totals', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@4', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@4', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.totals@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt', 'totalsPublishedAt', 'totalsComputedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt', 'totalsPublishedAt', 'totalsComputedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@11', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@11', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@12', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@12', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."cookbookId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."cookbookId", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."cookbookId"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."cookbookId"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."cookbookId", OLD."deletedAt") IS DISTINCT FROM (NEW."cookbookId", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."cookbookId"::uuid] || ARRAY[NEW."cookbookId"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@9', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@9', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."totals", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."totals", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@5', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@5', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@9', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@9', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."totals", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."totals", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@40', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@40', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@40', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_recipesection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[NEW."recipeId"::uuid], 'Recipe section created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[OLD."recipeId"::uuid], 'Recipe section removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals', ARRAY[OLD."recipeId"::uuid] || ARRAY[NEW."recipeId"::uuid], 'Recipe section changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[NEW."recipeId"::uuid], 'Recipe section created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."recipeId"::uuid], 'Recipe section removed'); END IF;
  ELSIF (true OR true) AND (OLD."recipeId", OLD."deletedAt", OLD."instructions") IS DISTINCT FROM (NEW."recipeId", NEW."deletedAt", NEW."instructions") THEN
    PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."recipeId"::uuid] || ARRAY[NEW."recipeId"::uuid], 'Recipe section changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."recipeId"::uuid], 'Recipe section created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."recipeId"::uuid], 'Recipe section removed'); END IF;
  ELSIF (true OR true) AND (OLD."recipeId", OLD."deletedAt", OLD."instructions") IS DISTINCT FROM (NEW."recipeId", NEW."deletedAt", NEW."instructions") THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."recipeId"::uuid] || ARRAY[NEW."recipeId"::uuid], 'Recipe section changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."recipeId"::uuid], 'Recipe section created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."recipeId"::uuid], 'Recipe section removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."recipeId"::uuid] || ARRAY[NEW."recipeId"::uuid], 'Recipe section changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@13', ARRAY[NEW."id"::uuid], 'Recipe section created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@13', ARRAY[OLD."id"::uuid], 'Recipe section removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."recipeId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."recipeId", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe section changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@41', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe section created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@41', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe section removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@41', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe section changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_recipesectioningredient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@6', ARRAY[NEW."recipeSectionId"::uuid], 'Recipe section ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@6', ARRAY[OLD."recipeSectionId"::uuid], 'Recipe section ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@6', ARRAY[OLD."recipeSectionId"::uuid] || ARRAY[NEW."recipeSectionId"::uuid], 'Recipe section ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@9', ARRAY[NEW."recipeSectionId"::uuid], 'Recipe section ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@9', ARRAY[OLD."recipeSectionId"::uuid], 'Recipe section ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@9', ARRAY[OLD."recipeSectionId"::uuid] || ARRAY[NEW."recipeSectionId"::uuid], 'Recipe section ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@9', ARRAY[NEW."recipeSectionId"::uuid], 'Recipe section ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@9', ARRAY[OLD."recipeSectionId"::uuid], 'Recipe section ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality@9', ARRAY[OLD."recipeSectionId"::uuid] || ARRAY[NEW."recipeSectionId"::uuid], 'Recipe section ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."ingredientId"::uuid], 'Recipe section ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid], 'Recipe section ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Recipe section ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@42', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe section ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@42', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe section ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@42', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe section ingredient changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@53', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Run created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@53', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Run removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.workDiagnosticFacts@53', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Run changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."id"::uuid], 'Run created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."id"::uuid], 'Run removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Run changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."purpose" = 'mail_import' THEN PERFORM derived_mark('email.dataQuality@19', ARRAY(SELECT (e->>'orderMailId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."input" #> '{sources}') = 'array' THEN NEW."input" #> '{sources}' ELSE '[]'::jsonb END) AS e WHERE e->>'orderMailId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Run created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."purpose" = 'mail_import' THEN PERFORM derived_mark('email.dataQuality@19', ARRAY(SELECT (e->>'orderMailId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD."input" #> '{sources}') = 'array' THEN OLD."input" #> '{sources}' ELSE '[]'::jsonb END) AS e WHERE e->>'orderMailId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Run removed'); END IF;
  ELSIF (OLD."purpose" = 'mail_import' OR NEW."purpose" = 'mail_import') AND (OLD."input", OLD."status", OLD."deletedAt", OLD."ledgerPartyId", OLD."purpose") IS DISTINCT FROM (NEW."input", NEW."status", NEW."deletedAt", NEW."ledgerPartyId", NEW."purpose") THEN
    PERFORM derived_mark('email.dataQuality@19', ARRAY(SELECT (e->>'orderMailId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD."input" #> '{sources}') = 'array' THEN OLD."input" #> '{sources}' ELSE '[]'::jsonb END) AS e WHERE e->>'orderMailId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'orderMailId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."input" #> '{sources}') = 'array' THEN NEW."input" #> '{sources}' ELSE '[]'::jsonb END) AS e WHERE e->>'orderMailId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Run changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_shipment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@43', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@43', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@43', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Shipment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.eventSummary', ARRAY[NEW."id"::uuid], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.eventSummary', ARRAY[OLD."id"::uuid], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.eventSummary', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Shipment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[NEW."id"::uuid], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."id"::uuid], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Shipment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."id"::uuid], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."id"::uuid], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Shipment changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_sourcetransactionrecord() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@44', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Source transaction record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@44', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Source transaction record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@44', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Source transaction record changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[NEW."id"::uuid], 'Source transaction record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."id"::uuid], 'Source transaction record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Source transaction record changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_spendingcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@32', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@32', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('purchase.dataQuality@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@11', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@11', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@12', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@12', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@29', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@29', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@30', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@30', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_suggestion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Suggestion removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entity" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entity" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."entity" = 'purchase' OR NEW."entity" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Suggestion changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Suggestion changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_task() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."subjectProductId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."subjectProductId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."subjectProductId", OLD."deletedAt") IS DISTINCT FROM (NEW."subjectProductId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."subjectProductId"::uuid] || ARRAY[NEW."subjectProductId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@8', ARRAY[NEW."parentTaskId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@8', ARRAY[OLD."parentTaskId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentTaskId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."parentTaskId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@8', ARRAY[OLD."parentTaskId"::uuid] || ARRAY[NEW."parentTaskId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@9', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@9', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."parentTaskId", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."parentTaskId", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@8', ARRAY[NEW."parentTaskId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@8', ARRAY[OLD."parentTaskId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentTaskId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."parentTaskId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@8', ARRAY[OLD."parentTaskId"::uuid] || ARRAY[NEW."parentTaskId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@9', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@9', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."parentTaskId", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."parentTaskId", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@46', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@46', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@46', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@8', ARRAY[NEW."parentTaskId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@8', ARRAY[OLD."parentTaskId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentTaskId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."parentTaskId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@8', ARRAY[OLD."parentTaskId"::uuid] || ARRAY[NEW."parentTaskId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@9', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@9', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."parentTaskId", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."parentTaskId", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@7', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@7', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('project.dataQuality@7', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@10', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@10', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."subjectProductId") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."subjectProductId") THEN
    PERFORM derived_mark('project.dataQuality@10', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@8', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@8', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@17', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@17', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."subjectProductId") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."subjectProductId") THEN
    PERFORM derived_mark('task.dataQuality@17', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@41', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@41', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."trade", OLD."projectId", OLD."subjectProductId", OLD."parentTaskId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."trade", NEW."projectId", NEW."subjectProductId", NEW."parentTaskId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@41', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@54', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@54', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."subjectProductId") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."subjectProductId") THEN
    PERFORM derived_mark('task.dataQuality@54', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_transactionimport() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@47', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@47', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@47', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[NEW."id"::uuid], 'Transaction import created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."id"::uuid], 'Transaction import removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Transaction import changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_transactionimportrecord() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@52', ARRAY[coalesce(NEW."importId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@52', ARRAY[coalesce(OLD."importId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@52', ARRAY[coalesce(OLD."importId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."importId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import record changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_vendor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@9', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@9', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@5', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@5', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@20', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@20', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@11', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@11', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@19', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@19', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@23', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@23', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@27', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@27', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@31', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@31', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@31', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@14', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@14', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@30', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@30', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@34', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@34', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@38', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@38', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@38', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@51', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@51', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@51', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@67', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@67', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@67', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@71', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@71', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@71', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@75', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@75', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@75', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@17', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@17', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@21', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@21', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@44', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@44', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@22', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@22', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@9', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@9', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@11', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@11', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@19', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@19', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@23', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@23', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@28', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@28', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@12', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@12', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@4', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@4', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('run.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@13', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@13', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_vendoraccount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@22', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@22', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@29', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@29', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@6', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@6', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@13', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@13', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@7', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@7', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@14', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@14', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@49', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@49', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@49', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@33', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@33', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@6', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@5', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@5', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@12', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@12', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_wish() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."id"::uuid], 'Wish created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."id"::uuid], 'Wish removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Wish changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality', ARRAY[NEW."id"::uuid], 'Wish created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."id"::uuid], 'Wish removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Wish changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "Suggestion_derived_mark" ON "Suggestion";
--> statement-breakpoint
CREATE TRIGGER "Suggestion_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Suggestion"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_suggestion();
--> statement-breakpoint
DO $verify$
BEGIN
  IF to_regclass('public."Assessment"') IS NOT NULL OR to_regclass('public."AssessmentState"') IS NOT NULL OR to_regclass('public."Feedback"') IS NOT NULL
    OR to_regclass('archive."Assessment"') IS NULL OR to_regclass('archive."AssessmentState"') IS NULL OR to_regclass('archive."Feedback"') IS NULL THEN
    RAISE EXCEPTION 'The review ledgers did not move to the archive schema';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('archive."Assessment"'::regclass, 'archive."AssessmentState"'::regclass, 'archive."Feedback"'::regclass))
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND (conrelid IN ('archive."Assessment"'::regclass, 'archive."AssessmentState"'::regclass, 'archive."Feedback"'::regclass)
      OR confrelid IN ('archive."Assessment"'::regclass, 'archive."AssessmentState"'::regclass, 'archive."Feedback"'::regclass))) THEN
    RAISE EXCEPTION 'An archived ledger still has a trigger or foreign key';
  END IF;
END $verify$;

-- Moves mail decisions and import findings to their domain owners. Assessment,
-- AssessmentState and Feedback keep every row; a later migration archives them.
-- Copy sources and destinations stay write-locked through commit, and any
-- preservation mismatch aborts this transaction and so the deployment.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- The mail evidence gate, then parents and domain tables before the ledgers, as
-- settlement writes them. Each table takes the strongest lock it needs here: an
-- upgrade later in this transaction could deadlock against a reader. Writers that
-- reach Assessment before Email remain possible; the runner retries that deadlock.
INSERT INTO "AssessmentCorrectionLock" (key) VALUES ('email-evidence-write')
  ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key;
--> statement-breakpoint
LOCK TABLE "Run" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "LedgerParty" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "OrderMail" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "OrderMailEvent" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "Email" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "EmailClassificationObservation" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "RunOperation" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "Assessment" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "AssessmentState" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "Feedback" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "EmailPurchaseDecision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eventId" uuid NOT NULL,
	"purchaseId" uuid NOT NULL,
	"decision" text NOT NULL,
	"evidenceChecksum" text NOT NULL,
	"decidedByUserId" text NOT NULL,
	"proposedBy" text,
	"authority" text NOT NULL,
	"status" text DEFAULT 'resolved' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"emailId" uuid,
	"originalId" uuid NOT NULL,
	"producer" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EmailPurchaseDecision_decision_check" CHECK ("EmailPurchaseDecision"."decision" IN ('linked', 'dismissed')),
	CONSTRAINT "EmailPurchaseDecision_authority_check" CHECK ("EmailPurchaseDecision"."authority" IN ('member', 'automatic', 'unknown')),
	CONSTRAINT "EmailPurchaseDecision_status_check" CHECK ("EmailPurchaseDecision"."status" IN ('resolved', 'applied', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "EmailReview" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family" text NOT NULL,
	"subjectId" uuid NOT NULL,
	"emailId" uuid,
	"originalId" uuid,
	"checksum" text,
	"classification" text,
	"operationId" text NOT NULL,
	"verdict" text NOT NULL,
	"correction" jsonb NOT NULL,
	"reason" text,
	"evidence" jsonb,
	"intent" text NOT NULL,
	"authority" text NOT NULL,
	"actorUserId" text,
	"subject" jsonb NOT NULL,
	"receipt" jsonb,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EmailReview_family_check" CHECK ("EmailReview"."family" IN ('email_relevance', 'email_link', 'mail_import_outcome', 'recommendation')),
	CONSTRAINT "EmailReview_verdict_check" CHECK ("EmailReview"."verdict" IN ('correct', 'wrong', 'uncertain', 'dismissed', 'ungraded')),
	CONSTRAINT "EmailReview_authority_check" CHECK ("EmailReview"."authority" IN ('member', 'automatic', 'unknown', 'system')),
	CONSTRAINT "EmailReview_classification_check" CHECK ("EmailReview"."classification" IN ('related', 'unrelated', 'uncertain'))
);
--> statement-breakpoint
CREATE TABLE "RunFinding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publicationKey" text NOT NULL,
	"runId" uuid,
	"ledgerPartyId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"entityId" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"proposedFix" jsonb,
	"probability" real,
	"expiresAt" timestamp,
	"evidenceFingerprint" text NOT NULL,
	"judgment" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"autoApplied" boolean DEFAULT false NOT NULL,
	"resolutions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunFinding_status_check" CHECK ("RunFinding"."status" IN ('pending', 'applied', 'rejected', 'superseded', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD COLUMN "application" text DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD COLUMN "publication" jsonb;--> statement-breakpoint
ALTER TABLE "RunFinding" ADD CONSTRAINT "RunFinding_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunFinding" ADD CONSTRAINT "RunFinding_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "EmailPurchaseDecision_event_purchase_key" ON "EmailPurchaseDecision" USING btree ("eventId","purchaseId") WHERE "EmailPurchaseDecision"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "EmailPurchaseDecision_one_link_key" ON "EmailPurchaseDecision" USING btree ("eventId") WHERE "EmailPurchaseDecision"."active" AND "EmailPurchaseDecision"."decision" = 'linked';--> statement-breakpoint
CREATE INDEX "EmailPurchaseDecision_purchase_idx" ON "EmailPurchaseDecision" USING btree ("purchaseId") WHERE "EmailPurchaseDecision"."active";--> statement-breakpoint
CREATE INDEX "EmailPurchaseDecision_email_idx" ON "EmailPurchaseDecision" USING btree ("emailId");--> statement-breakpoint
CREATE INDEX "EmailPurchaseDecision_original_idx" ON "EmailPurchaseDecision" USING btree ("originalId");--> statement-breakpoint
CREATE UNIQUE INDEX "EmailReview_operation_key" ON "EmailReview" USING btree ("subjectId","operationId");--> statement-breakpoint
CREATE INDEX "EmailReview_email_idx" ON "EmailReview" USING btree ("emailId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "EmailReview_original_idx" ON "EmailReview" USING btree ("originalId") WHERE "EmailReview"."emailId" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "RunFinding_publication_key" ON "RunFinding" USING btree ("publicationKey");--> statement-breakpoint
CREATE INDEX "RunFinding_run_idx" ON "RunFinding" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "RunFinding_ledger_party_idx" ON "RunFinding" USING btree ("ledgerPartyId");--> statement-breakpoint
CREATE INDEX "RunFinding_target_idx" ON "RunFinding" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE INDEX "RunFinding_open_idx" ON "RunFinding" USING btree ("createdAt","id") WHERE "RunFinding"."active" AND "RunFinding"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "RunOperation_mail_outcome_email_idx" ON "RunOperation" USING btree (("result" #>> '{target,entityId}'),"completedAt" DESC NULLS LAST) WHERE "RunOperation"."kind" = 'target_outcome' AND ("RunOperation"."result"->'mailOutcome') IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "RunOperation_mail_outcome_id_key" ON "RunOperation" USING btree (("result" #>> '{mailOutcome,id}')) WHERE "RunOperation"."kind" = 'target_outcome' AND ("RunOperation"."result"->'mailOutcome') IS NOT NULL;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_application_check" CHECK ("EmailClassificationObservation"."application" IN ('observed', 'applied', 'unverified'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_assessment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'field' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'field' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'field' OR NEW."family" = 'field') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'recommendation' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'recommendation' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'recommendation' OR NEW."family" = 'recommendation') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'product_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'product_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'product_pair' OR NEW."family" = 'product_pair') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'statement_transaction' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'statement_transaction' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'statement_transaction' OR NEW."family" = 'statement_transaction') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'transfer_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'transfer_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'transfer_pair' OR NEW."family" = 'transfer_pair') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@175', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@175', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."served") IS DISTINCT FROM (NEW."id", NEW."served") THEN
    PERFORM derived_mark('assessment.reviewFacts@175', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_assessmentstate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entity" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entity" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."entity" = 'purchase' OR NEW."entity" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'field' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'field' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'field' OR NEW."family" = 'field') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'recommendation' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'recommendation' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'recommendation' OR NEW."family" = 'recommendation') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'product_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'product_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'product_pair' OR NEW."family" = 'product_pair') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'statement_transaction' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'statement_transaction' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'statement_transaction' OR NEW."family" = 'statement_transaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'transfer_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'transfer_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'transfer_pair' OR NEW."family" = 'transfer_pair') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts@107', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts@107', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@107', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'field' AND NEW."entity" = 'financialAccount' THEN PERFORM derived_mark('assessment.reviewFacts@170', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'field' AND OLD."entity" = 'financialAccount' THEN PERFORM derived_mark('assessment.reviewFacts@170', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'field' AND OLD."entity" = 'financialAccount' OR NEW."family" = 'field' AND NEW."entity" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@170', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@176', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@176', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@176', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_feedback() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('product.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('product.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('recipe.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('recipe.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('location.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('location.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('inventory.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('inventory.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('meal.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('meal.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('project.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('project.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('task.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('task.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('vendor.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('vendor.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('purchase.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('purchase.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('wish.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('wish.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('expense.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('expense.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('image.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('image.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('planting.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('planting.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('plant.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('plant.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@12', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@12', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@12', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('assessment.reviewFacts@108', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('assessment.reviewFacts@108', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@108', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- A link's current state: the row the retired view read, plus retained inactive ones.
INSERT INTO "EmailPurchaseDecision" (id, "eventId", "purchaseId", decision, "evidenceChecksum", "decidedByUserId", "proposedBy", authority, status, active, "emailId", "originalId", producer, "createdAt", "updatedAt")
SELECT s.id, (s.data->>'eventId')::uuid, (s.data->>'purchaseId')::uuid, s.data->>'decision', s.data->>'evidenceChecksum', s.data->>'decidedByUserId', s.data->>'proposedBy',
  COALESCE(decided.authority, 'unknown'), s.status, s.active,
  CASE WHEN s.entity = 'email' THEN s."recordId" END,
  (a.subject->>'originalId')::uuid, a.producer, s."createdAt", s."updatedAt"
FROM "AssessmentState" s
JOIN "Assessment" a ON a.id = s.id
LEFT JOIN LATERAL (SELECT f.authority FROM "Feedback" f WHERE f."assessmentId" = s.id AND f."operationId" IN ('decision', 'legacy-decision') ORDER BY f."createdAt" DESC, f.id DESC LIMIT 1) decided ON true
WHERE s.family = 'email_link';
--> statement-breakpoint
-- Member labels and every intent that protects an Email, across retained subjects.
INSERT INTO "EmailReview" (id, family, "subjectId", "emailId", "originalId", checksum, classification, "operationId", verdict, correction, reason, evidence, intent, authority, "actorUserId", subject, receipt, metadata, "createdAt")
SELECT f.id,
    a.family,
    CASE WHEN a.family = 'email_relevance' THEN COALESCE(o.id, (a.subject->>'observationId')::uuid, a.id) ELSE a.id END,
    CASE WHEN a.family = 'email_relevance' AND o.id IS NOT NULL THEN o."emailId" ELSE (a.subject->>'recordId')::uuid END,
    CASE WHEN a.family = 'email_link' THEN (a.subject->>'originalId')::uuid END,
    CASE WHEN a.family = 'email_relevance' AND o.id IS NOT NULL THEN o.checksum WHEN a.family = 'recommendation' THEN NULL ELSE a.subject->>'checksum' END,
    CASE WHEN a.family = 'email_relevance' AND o.id IS NOT NULL THEN NULLIF(
      CASE WHEN (CASE WHEN f.correction @> '{"present":true}'::jsonb THEN f.correction->>'value' WHEN f.verdict = 'correct' THEN a.judgment->>'classification' END) IN ('related', 'unrelated', 'uncertain')
        THEN (CASE WHEN f.correction @> '{"present":true}'::jsonb THEN f.correction->>'value' WHEN f.verdict = 'correct' THEN a.judgment->>'classification' END) END, '') END,
    f."operationId", f.verdict, f.correction, f.reason, f.evidence, f.intent, f.authority, f."actorUserId",
    CASE WHEN a.family = 'recommendation' THEN a.subject || jsonb_build_object('candidate', jsonb_build_object('relation', a.evidence #> '{candidate,relation}', 'source', a.evidence #> '{candidate,source}', 'target', a.evidence #> '{candidate,target}')) ELSE a.subject END,
    f.receipt, f.metadata, f."createdAt"
FROM "Feedback" f
JOIN "Assessment" a ON a.id = f."assessmentId"
LEFT JOIN "EmailClassificationObservation" o ON a.family = 'email_relevance' AND a."publicationKey" = 'email-observation:' || o.id::text
WHERE (
    (a.family IN ('email_relevance', 'email_link') AND (((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link')) OR f.metadata->>'kind' IN ('assessment_application', 'email_review_frontier')))
    OR ((a.family = 'recommendation' AND a.subject->>'scope' = 'connection.email-purchase' AND a.subject->>'entity' = 'email') AND ((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link')))
    OR (a.family = 'mail_import_outcome' AND f.authority = 'member')
  );
--> statement-breakpoint
INSERT INTO "RunFinding" (id, "publicationKey", "runId", "ledgerPartyId", "entityKind", "entityId", kind, summary, "proposedFix", probability, "expiresAt", "evidenceFingerprint", judgment, status, active, "autoApplied", resolutions, "createdAt", "updatedAt")
SELECT s.id, a."publicationKey", s."runId", s."ledgerPartyId", s.entity, s."recordId", s.data->>'kind', s.data->>'summary',
  NULLIF(s.data->'proposedFix', 'null'::jsonb), (s.data->>'probability')::real,
  ((s.data->>'expiresAt')::timestamptz AT TIME ZONE 'UTC'), s.fingerprint, a.judgment, s.status, s.active,
  EXISTS (SELECT 1 FROM "Feedback" f WHERE f."assessmentId" = s.id AND f.authority = 'automatic'),
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'operationId', f."operationId", 'verdict', f.verdict, 'correction', f.correction, 'reason', f.reason, 'evidence', f.evidence,
      'intent', f.intent, 'authority', f.authority, 'actorUserId', f."actorUserId", 'receipt', f.receipt, 'metadata', f.metadata,
      'createdAt', to_char(f."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY f."createdAt", f.id)
    FROM "Feedback" f WHERE f."assessmentId" = s.id AND f.authority <> 'system' AND f.intent <> 'projection'), '[]'::jsonb),
  s."createdAt", s."updatedAt"
FROM "AssessmentState" s
JOIN "Assessment" a ON a.id = s.id
WHERE s.family = 'run_finding';
--> statement-breakpoint
-- An outcome and its target_outcome share one settling transaction, so now()
-- gave both the same timestamp: that, not row order, is their identity.
CREATE TEMP TABLE mail_outcome_pairs ON COMMIT DROP AS
SELECT a.id AS outcome, r.id AS operation
FROM "Assessment" a
LEFT JOIN "RunOperation" r ON r."runId"::text = a.subject->>'runId'
  AND r.kind = 'target_outcome'
  AND r.result #>> '{target,entityKind}' = 'email'
  AND r.result #>> '{target,entityId}' = a.subject->>'recordId'
  AND r.result #>> '{target,targetFingerprint}' = a.subject->>'checksum'
  AND r."createdAt" = a."createdAt"
WHERE a.family = 'mail_import_outcome';
--> statement-breakpoint
DO $pairing$
BEGIN
  IF EXISTS (SELECT 1 FROM mail_outcome_pairs WHERE operation IS NULL)
    OR EXISTS (SELECT 1 FROM mail_outcome_pairs GROUP BY outcome HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM mail_outcome_pairs GROUP BY operation HAVING count(*) > 1)
  THEN
    RAISE EXCEPTION 'Mail decision cutover preservation failed: mail import outcome pairing is missing or ambiguous';
  END IF;
END $pairing$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.mail_outcome_snapshot(a "Assessment") RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', a.id, 'judgment', a.judgment, 'producer', a.producer, 'checksum', a.subject->>'checksum',
    'fingerprint', a.fingerprint, 'createdAt', to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;
--> statement-breakpoint
-- Each writes one row per retained outcome or prediction: these updates are not
-- source changes, so they must not enroll the Runs or Emails they touch.
ALTER TABLE "RunOperation" DISABLE TRIGGER "RunOperation_derived_mark";
--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" DISABLE TRIGGER "EmailClassificationObservation_derived_mark";
--> statement-breakpoint
UPDATE "RunOperation" r SET result = r.result || jsonb_build_object('mailOutcome', pg_temp.mail_outcome_snapshot(a))
FROM mail_outcome_pairs p JOIN "Assessment" a ON a.id = p.outcome
WHERE p.operation = r.id;
--> statement-breakpoint
-- A prediction's receipts become its application state; its publication proof moves too.
UPDATE "EmailClassificationObservation" o SET
  application = CASE WHEN receipts.applied THEN 'applied' WHEN receipts.observed THEN 'observed' ELSE 'unverified' END,
  publication = a.evidence - 'checksum' - 'provenance'
FROM "Assessment" a
JOIN LATERAL (
  SELECT COALESCE(bool_or(f.authority = 'automatic' AND (f.metadata->>'kind' = 'email_classification_application' OR f."operationId" = 'resolution')), false) AS applied,
    COALESCE(bool_or(f.metadata->>'kind' = 'email_classification_observation'), false) AS observed
  FROM "Feedback" f WHERE f."assessmentId" = a.id
) receipts ON true
WHERE a.family = 'email_relevance' AND a."publicationKey" = 'email-observation:' || o.id::text;
--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ENABLE TRIGGER "EmailClassificationObservation_derived_mark";
--> statement-breakpoint
ALTER TABLE "RunOperation" ENABLE TRIGGER "RunOperation_derived_mark";
--> statement-breakpoint
CREATE FUNCTION pg_temp.mail_cutover_assert_same(label text, expected text, actual text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE mismatches bigint;
BEGIN
  -- Row text keeps nulls distinct from empty strings, and counts keep it a multiset.
  EXECUTE format($q$
    WITH e AS (SELECT md5(x::text) AS h, count(*) AS n FROM (%s) x GROUP BY 1),
         a AS (SELECT md5(x::text) AS h, count(*) AS n FROM (%s) x GROUP BY 1)
    SELECT count(*) FROM e FULL JOIN a USING (h) WHERE e.n IS DISTINCT FROM a.n
  $q$, expected, actual) INTO mismatches;
  IF mismatches > 0 THEN
    RAISE EXCEPTION 'Mail decision cutover preservation failed: % (% differing row hashes)', label, mismatches;
  END IF;
END $fn$;
--> statement-breakpoint
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "AssessmentState" WHERE family IN ('email_link', 'run_finding') AND (suppression IS NOT NULL OR "confirmedValue" IS NOT NULL))
    OR EXISTS (SELECT 1 FROM "Feedback" f JOIN "Assessment" a ON a.id = f."assessmentId" WHERE a.family IN ('email_link', 'email_relevance', 'mail_import_outcome', 'run_finding') AND f.suppression IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id WHERE (a.family IN ('email_link', 'run_finding') OR s.family IN ('email_link', 'run_finding')) AND a.family <> s.family)
    OR EXISTS (SELECT 1 FROM "Assessment" a LEFT JOIN "AssessmentState" s ON s.id = a.id WHERE a.family IN ('email_link', 'run_finding') AND s.id IS NULL)
    OR EXISTS (SELECT 1 FROM "AssessmentState" s LEFT JOIN "Assessment" a ON a.id = s.id WHERE s.family IN ('email_link', 'run_finding') AND a.id IS NULL)
  THEN
    RAISE EXCEPTION 'Mail decision cutover preservation failed: a retained row has no destination shape';
  END IF;
END $guard$;
--> statement-breakpoint
SELECT pg_temp.mail_cutover_assert_same('email purchase decisions',
  $check$SELECT s.id::text, s.data->>'eventId', s.data->>'purchaseId', s.data->>'decision', s.data->>'evidenceChecksum', s.data->>'decidedByUserId', s.data->>'proposedBy', s.status, s.active,
      CASE WHEN s.entity = 'email' THEN s."recordId"::text END, a.subject->>'originalId', a.producer::text, s."createdAt", s."updatedAt"
    FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id WHERE s.family = 'email_link' $check$,
  $check$SELECT d.id::text, d."eventId"::text, d."purchaseId"::text, d.decision, d."evidenceChecksum", d."decidedByUserId", d."proposedBy", d.status, d.active,
      d."emailId"::text, d."originalId"::text, d.producer::text, d."createdAt", d."updatedAt"
    FROM "EmailPurchaseDecision" d$check$);
--> statement-breakpoint
-- A missed link makes clearUnrelatedOriginal wipe a body irreversibly.
SELECT pg_temp.mail_cutover_assert_same('Emails with an accepted association',
  $check$SELECT DISTINCT e.id::text, link."purchaseId"::text
    FROM "AssessmentEmailLink" link
    JOIN "OrderMailEvent" event ON event.id = link."eventId"
    JOIN "OrderMail" original ON original.id = event."orderMailId"
    JOIN "Email" e ON e."orderMailId" = original.id AND e."ledgerPartyId" = original."ledgerPartyId"
    WHERE link.decision = 'linked' AND event."supersededAt" IS NULL$check$,
  $check$SELECT DISTINCT e.id::text, link."purchaseId"::text
    FROM "EmailPurchaseDecision" link
    JOIN "OrderMailEvent" event ON event.id = link."eventId"
    JOIN "OrderMail" original ON original.id = event."orderMailId"
    JOIN "Email" e ON e."orderMailId" = original.id AND e."ledgerPartyId" = original."ledgerPartyId"
    WHERE link.active AND link.decision = 'linked' AND event."supersededAt" IS NULL$check$);
--> statement-breakpoint
SELECT pg_temp.mail_cutover_assert_same('member relevance labels',
  $check$SELECT f.id::text, o."emailId"::text, o.checksum, (CASE WHEN f.correction @> '{"present":true}'::jsonb THEN f.correction->>'value' WHEN f.verdict = 'correct' THEN a.judgment->>'classification' END), f."actorUserId", f.reason, f.correction::text, f."createdAt"::text
    FROM "EmailClassificationObservation" o
  JOIN "Assessment" a ON a."publicationKey" = 'email-observation:' || o.id::text AND a.family = 'email_relevance'
  JOIN "Feedback" f ON f."assessmentId" = a.id
  WHERE f.authority = 'member'
    AND (CASE WHEN f.correction @> '{"present":true}'::jsonb THEN f.correction->>'value' WHEN f.verdict = 'correct' THEN a.judgment->>'classification' END) IN ('related', 'unrelated', 'uncertain')$check$,
  $check$SELECT r.id::text, r."emailId"::text, r.checksum, r.classification, r."actorUserId", r.reason, r.correction::text, r."createdAt"::text
    FROM "EmailReview" r WHERE r.authority = 'member' AND r.classification IS NOT NULL$check$);
--> statement-breakpoint
SELECT pg_temp.mail_cutover_assert_same('current member classification per Email',
  $check$SELECT DISTINCT ON (e.id) e.id::text, (CASE WHEN f.correction @> '{"present":true}'::jsonb THEN f.correction->>'value' WHEN f.verdict = 'correct' THEN a.judgment->>'classification' END)
    FROM "EmailClassificationObservation" o
  JOIN "Assessment" a ON a."publicationKey" = 'email-observation:' || o.id::text AND a.family = 'email_relevance'
  JOIN "Feedback" f ON f."assessmentId" = a.id
  AND true JOIN "Email" e ON e.id = o."emailId" AND e.checksum = o.checksum JOIN "LedgerParty" owner ON owner.id = e."ledgerPartyId" AND owner."userId" = f."actorUserId" WHERE f.authority = 'member'
    AND (CASE WHEN f.correction @> '{"present":true}'::jsonb THEN f.correction->>'value' WHEN f.verdict = 'correct' THEN a.judgment->>'classification' END) IN ('related', 'unrelated', 'uncertain')
    ORDER BY e.id, f."createdAt" DESC, f.id DESC$check$,
  $check$SELECT DISTINCT ON (e.id) e.id::text, r.classification
    FROM "EmailReview" r
    JOIN "Email" e ON e.id = r."emailId" AND e.checksum = r.checksum
    JOIN "LedgerParty" owner ON owner.id = e."ledgerPartyId" AND owner."userId" = r."actorUserId"
    WHERE r.authority = 'member' AND r.classification IS NOT NULL
    ORDER BY e.id, r."createdAt" DESC, r.id DESC$check$);
--> statement-breakpoint
SELECT pg_temp.mail_cutover_assert_same('protecting intent events per Email',
  $check$SELECT f.id::text, e.id::text
  FROM "Feedback" f
  JOIN "Assessment" a ON a.id = f."assessmentId"
  JOIN "Email" e ON e.id::text = a.subject->>'recordId'
  WHERE (a.family IN ('email_relevance', 'email_link') OR (a.family = 'recommendation' AND a.subject->>'scope' = 'connection.email-purchase' AND a.subject->>'entity' = 'email')) AND ((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link'))
  UNION ALL
  SELECT f.id::text, e.id::text
  FROM "Feedback" f
  JOIN "Assessment" a ON a.id = f."assessmentId"
  JOIN "Email" e ON e."orderMailId"::text = a.subject->>'originalId'
  WHERE a.family = 'email_link' AND a.subject->>'recordId' IS NULL AND ((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link'))$check$,
  $check$SELECT f.id::text, e.id::text
  FROM "EmailReview" f
  JOIN "Email" e ON e.id = f."emailId"
  WHERE f.family IN ('email_relevance', 'email_link', 'recommendation') AND ((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link'))
  UNION ALL
  SELECT f.id::text, e.id::text
  FROM "EmailReview" f
  JOIN "Email" e ON e."orderMailId" = f."originalId"
  WHERE f.family = 'email_link' AND f."emailId" IS NULL AND ((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link'))$check$);
--> statement-breakpoint
-- Every copied event in full, including wrong and uncertain ones with no label.
SELECT pg_temp.mail_cutover_assert_same('retained Email reviews',
  $check$SELECT f.id,
    a.family,
    CASE WHEN a.family = 'email_relevance' THEN COALESCE(o.id, (a.subject->>'observationId')::uuid, a.id) ELSE a.id END,
    CASE WHEN a.family = 'email_relevance' AND o.id IS NOT NULL THEN o."emailId" ELSE (a.subject->>'recordId')::uuid END,
    CASE WHEN a.family = 'email_link' THEN (a.subject->>'originalId')::uuid END,
    CASE WHEN a.family = 'email_relevance' AND o.id IS NOT NULL THEN o.checksum WHEN a.family = 'recommendation' THEN NULL ELSE a.subject->>'checksum' END,
    CASE WHEN a.family = 'email_relevance' AND o.id IS NOT NULL THEN NULLIF(
      CASE WHEN (CASE WHEN f.correction @> '{"present":true}'::jsonb THEN f.correction->>'value' WHEN f.verdict = 'correct' THEN a.judgment->>'classification' END) IN ('related', 'unrelated', 'uncertain')
        THEN (CASE WHEN f.correction @> '{"present":true}'::jsonb THEN f.correction->>'value' WHEN f.verdict = 'correct' THEN a.judgment->>'classification' END) END, '') END,
    f."operationId", f.verdict, f.correction, f.reason, f.evidence, f.intent, f.authority, f."actorUserId",
    CASE WHEN a.family = 'recommendation' THEN a.subject || jsonb_build_object('candidate', jsonb_build_object('relation', a.evidence #> '{candidate,relation}', 'source', a.evidence #> '{candidate,source}', 'target', a.evidence #> '{candidate,target}')) ELSE a.subject END,
    f.receipt, f.metadata, f."createdAt"
    FROM "Feedback" f JOIN "Assessment" a ON a.id = f."assessmentId"
    LEFT JOIN "EmailClassificationObservation" o ON a.family = 'email_relevance' AND a."publicationKey" = 'email-observation:' || o.id::text
    WHERE (
    (a.family IN ('email_relevance', 'email_link') AND (((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link')) OR f.metadata->>'kind' IN ('assessment_application', 'email_review_frontier')))
    OR ((a.family = 'recommendation' AND a.subject->>'scope' = 'connection.email-purchase' AND a.subject->>'entity' = 'email') AND ((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link')))
    OR (a.family = 'mail_import_outcome' AND f.authority = 'member')
  )$check$,
  $check$SELECT id, family, "subjectId", "emailId", "originalId", checksum, classification, "operationId", verdict, correction, reason, evidence, intent, authority, "actorUserId", subject, receipt, metadata, "createdAt"
    FROM "EmailReview"$check$);
--> statement-breakpoint
-- Every event of these families is copied or named here, or the migration aborts.
DO $accounting$
DECLARE counts record;
BEGIN
  SELECT count(*) AS total,
    count(*) FILTER (WHERE category = 'review') AS reviews,
    count(*) FILTER (WHERE category = 'resolution') AS resolutions,
    count(*) FILTER (WHERE category = 'unaccounted') AS unaccounted
  INTO counts
  FROM (SELECT CASE
      WHEN a.family <> 'run_finding' AND (
    (a.family IN ('email_relevance', 'email_link') AND (((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link')) OR f.metadata->>'kind' IN ('assessment_application', 'email_review_frontier')))
    OR ((a.family = 'recommendation' AND a.subject->>'scope' = 'connection.email-purchase' AND a.subject->>'entity' = 'email') AND ((f.authority = 'member' AND (f.metadata->>'kind' IS NULL OR f.metadata->>'kind' NOT IN ('assessment_application', 'saved_field')))
    OR f.metadata->>'kind' IN ('email_resolution', 'email_link')))
    OR (a.family = 'mail_import_outcome' AND f.authority = 'member')
  ) THEN 'review'
      WHEN f.intent = 'projection' THEN 'projection'
      WHEN a.family = 'run_finding' AND f.authority <> 'system' THEN 'resolution'
      WHEN a.family = 'email_relevance' AND f.authority = 'evaluation' AND f.metadata->>'kind' = 'email_accuracy' THEN 'independent_grade'
      WHEN a.family = 'email_relevance' AND f.authority = 'automatic' AND f.metadata->>'kind' IN ('email_classification_observation', 'email_classification_application') THEN 'routing_receipt'
      WHEN a.family = 'email_link' AND f.authority = 'unknown' AND f."operationId" = 'legacy-decision' THEN 'unknown_link_decision'
      ELSE 'unaccounted' END AS category
    FROM "Feedback" f
    JOIN "Assessment" a ON a.id = f."assessmentId"
    WHERE a.family IN ('email_relevance', 'email_link', 'mail_import_outcome', 'run_finding')) events;
  IF counts.unaccounted > 0
    OR counts.reviews <> (SELECT count(*) FROM "EmailReview" WHERE family <> 'recommendation')
    OR counts.resolutions <> (SELECT COALESCE(sum(jsonb_array_length(resolutions)), 0) FROM "RunFinding")
  THEN
    RAISE EXCEPTION 'Mail decision cutover preservation failed: Feedback accounting (% events: % reviews, % resolutions, % unaccounted)',
      counts.total, counts.reviews, counts.resolutions, counts.unaccounted;
  END IF;
END $accounting$;
--> statement-breakpoint
SELECT pg_temp.mail_cutover_assert_same('run findings',
  $check$SELECT s.id::text, s.status, s.active, a."publicationKey", s."runId"::text, s.entity, s."recordId"::text, s."ledgerPartyId"::text, s.data->>'kind', s.data->>'summary',
      NULLIF(s.data->'proposedFix', 'null'::jsonb)::text, (s.data->>'probability')::real, ((s.data->>'expiresAt')::timestamptz AT TIME ZONE 'UTC'), s.fingerprint, a.judgment::text
    FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id WHERE s.family = 'run_finding' $check$,
  $check$SELECT r.id::text, r.status, r.active, r."publicationKey", r."runId"::text, r."entityKind", r."entityId"::text, r."ledgerPartyId"::text, r.kind, r.summary,
      r."proposedFix"::text, r.probability, r."expiresAt", r."evidenceFingerprint", r.judgment::text
    FROM "RunFinding" r$check$);
--> statement-breakpoint
SELECT pg_temp.mail_cutover_assert_same('run finding resolutions',
  $check$SELECT f."assessmentId"::text, f.id::text, f."operationId", f.verdict, f.correction::text, f.reason, COALESCE(f.evidence, 'null'::jsonb)::text, f.intent, f.authority, f."actorUserId",
      COALESCE(f.receipt, 'null'::jsonb)::text, COALESCE(f.metadata, 'null'::jsonb)::text, to_char(f."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM "Feedback" f JOIN "Assessment" a ON a.id = f."assessmentId"
    WHERE a.family = 'run_finding' AND f.authority <> 'system' AND f.intent <> 'projection' $check$,
  $check$SELECT r.id::text, e.value->>'id', e.value->>'operationId', e.value->>'verdict', (e.value->'correction')::text, e.value->>'reason', (e.value->'evidence')::text, e.value->>'intent', e.value->>'authority', e.value->>'actorUserId',
      (e.value->'receipt')::text, (e.value->'metadata')::text, e.value->>'createdAt'
    FROM "RunFinding" r CROSS JOIN LATERAL jsonb_array_elements(r.resolutions) e(value)$check$);
--> statement-breakpoint
SELECT pg_temp.mail_cutover_assert_same('mail import outcomes',
  $check$SELECT a.id::text, a.judgment::text, a.producer::text, a.subject->>'checksum', a.fingerprint, a.subject->>'runId', a.subject->>'recordId', r.id::text, r."operationId"
    FROM "Assessment" a
    JOIN "RunOperation" r ON r."runId"::text = a.subject->>'runId' AND r.kind = 'target_outcome'
      AND r.result #>> '{target,entityKind}' = 'email' AND r.result #>> '{target,entityId}' = a.subject->>'recordId'
      AND r.result #>> '{target,targetFingerprint}' = a.subject->>'checksum' AND r."createdAt" = a."createdAt"
    WHERE a.family = 'mail_import_outcome' $check$,
  $check$SELECT r.result #>> '{mailOutcome,id}', (r.result #> '{mailOutcome,judgment}')::text, NULLIF(r.result #> '{mailOutcome,producer}', 'null'::jsonb)::text,
      r.result #>> '{mailOutcome,checksum}', r.result #>> '{mailOutcome,fingerprint}', r."runId"::text, r.result #>> '{target,entityId}', r.id::text, r."operationId"
    FROM "RunOperation" r WHERE r.kind = 'target_outcome' AND (r.result->'mailOutcome') IS NOT NULL$check$);
--> statement-breakpoint
SELECT pg_temp.mail_cutover_assert_same('prediction application',
  $check$SELECT o.id::text, CASE WHEN bool_or(f.authority = 'automatic' AND (f.metadata->>'kind' = 'email_classification_application' OR f."operationId" = 'resolution')) THEN 'applied'
        WHEN bool_or(f.metadata->>'kind' = 'email_classification_observation') THEN 'observed' ELSE 'unverified' END
    FROM "EmailClassificationObservation" o
    JOIN "Assessment" a ON a.family = 'email_relevance' AND a."publicationKey" = 'email-observation:' || o.id::text
    LEFT JOIN "Feedback" f ON f."assessmentId" = a.id
    GROUP BY o.id$check$,
  $check$SELECT o.id::text, o.application FROM "EmailClassificationObservation" o
    WHERE EXISTS (SELECT 1 FROM "Assessment" a WHERE a.family = 'email_relevance' AND a."publicationKey" = 'email-observation:' || o.id::text)$check$);
--> statement-breakpoint
DROP FUNCTION pg_temp.mail_cutover_assert_same(text, text, text);
--> statement-breakpoint
DROP FUNCTION pg_temp.mail_outcome_snapshot("Assessment");
--> statement-breakpoint
DROP VIEW "AssessmentEmailLink";
--> statement-breakpoint
-- A stale Worker still writing these families fails rather than losing a decision.
CREATE OR REPLACE FUNCTION "assessment_retired_family_refused"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.family IN ('email_relevance', 'email_link', 'mail_import_outcome', 'run_finding') THEN
    RAISE EXCEPTION 'Assessment family % moved to its domain owner', NEW.family;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "Assessment_retired_family" BEFORE INSERT ON "Assessment"
  FOR EACH ROW EXECUTE FUNCTION "assessment_retired_family_refused"();
--> statement-breakpoint
CREATE TRIGGER "AssessmentState_retired_family" BEFORE INSERT OR UPDATE OF status, active, data, entity, "recordId" ON "AssessmentState"
  FOR EACH ROW EXECUTE FUNCTION "assessment_retired_family_refused"();
--> statement-breakpoint
-- A review of a retained decision would commit where nothing reads it.
CREATE OR REPLACE FUNCTION "feedback_retired_family_refused"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Assessment" a WHERE a.id = NEW."assessmentId"
    AND a.family IN ('email_relevance', 'email_link', 'mail_import_outcome', 'run_finding')) THEN
    RAISE EXCEPTION 'Feedback on Assessment % moved to its domain owner', NEW."assessmentId";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "Feedback_retired_family" BEFORE INSERT ON "Feedback"
  FOR EACH ROW EXECUTE FUNCTION "feedback_retired_family_refused"();
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
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@163', ARRAY[NEW."eventId"::uuid], 'Email purchase decision created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@163', ARRAY[OLD."eventId"::uuid], 'Email purchase decision removed'); END IF;
  ELSIF (true OR true) AND (OLD."eventId", OLD."purchaseId", OLD."decision", OLD."evidenceChecksum", OLD."proposedBy", OLD."active") IS DISTINCT FROM (NEW."eventId", NEW."purchaseId", NEW."decision", NEW."evidenceChecksum", NEW."proposedBy", NEW."active") THEN
    PERFORM derived_mark('assessment.reviewFacts@163', ARRAY[OLD."eventId"::uuid] || ARRAY[NEW."eventId"::uuid], 'Email purchase decision changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "EmailPurchaseDecision_derived_mark" ON "EmailPurchaseDecision";
CREATE TRIGGER "EmailPurchaseDecision_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EmailPurchaseDecision"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_emailpurchasedecision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_emailreview() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."emailId"::uuid], 'Email review created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."emailId"::uuid], 'Email review removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."emailId"::uuid] || ARRAY[NEW."emailId"::uuid], 'Email review changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "EmailReview_derived_mark" ON "EmailReview";
CREATE TRIGGER "EmailReview_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EmailReview"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_emailreview();

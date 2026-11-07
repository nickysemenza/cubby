-- Consolidated through 0103_statement_charge_history. Historical SQL lives in Git.
-- Built from a fresh replay of the retired journal; db:check verifies desired state.
SET LOCAL check_function_bodies = false;

CREATE FUNCTION public.assessment_history_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% history is immutable', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION public.assessment_mail_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_TABLE_NAME='Email' THEN
  IF TG_OP='DELETE' OR NEW."deletedAt" IS NOT NULL THEN
   UPDATE "AssessmentState" SET entity='orderMailEvent',"recordId"=(data->>'eventId')::uuid,"updatedAt"=now() WHERE family='email_link' AND entity='email' AND "recordId"=OLD.id;
   UPDATE "AssessmentState" SET active=false,status='superseded',"updatedAt"=now() WHERE entity='email' AND "recordId"=OLD.id;
  END IF;
 ELSE
  IF TG_OP='DELETE' OR NEW."supersededAt" IS NOT NULL THEN
   UPDATE "AssessmentState" SET active=false,status='superseded',"updatedAt"=now() WHERE family='email_link' AND data->>'eventId'=OLD.id::text;
  END IF;
 END IF;
 RETURN NULL;
END;
$$;

CREATE FUNCTION public.entity_identity_on_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE "Entity"
  SET "deletedAt" = COALESCE("deletedAt", OLD."deletedAt", now())
  WHERE "id" = OLD."id";
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.entity_identity_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "Entity" ("id", "kind", "shortcode", "createdAt", "deletedAt")
  VALUES (NEW."id", TG_ARGV[0], NEW."shortcode", NEW."createdAt", NEW."deletedAt");
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.entity_identity_on_soft_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE "Entity" SET "deletedAt" = NEW."deletedAt" WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.entity_link_require_live_endpoints() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Entity"
    WHERE "id" IN (NEW."fromEntityId", NEW."toEntityId")
      AND "deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EntityLink % (%) names a deleted entity: % -> %',
      NEW."id", NEW."kind", NEW."fromEntityId", NEW."toEntityId"
      USING ERRCODE = '23503', CONSTRAINT = 'EntityLink_live_endpoints_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.publish_field_assessment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.family = 'field' AND NOT EXISTS (SELECT 1 FROM "Assessment" WHERE id = NEW.id) THEN
    INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment, fingerprint, producer, evidence, served, "createdAt")
    VALUES (NEW.id, 'field:' || NEW.id::text, 'field',
      jsonb_build_object('kind','field','entity',NEW.entity,'recordId',NEW."recordId",'field',NEW.field,'draft',false),
      jsonb_build_object('value',NEW."suggestedValue",'confidence',NEW.confidence,'runnerUpValue',NEW."runnerUpValue",'runnerUpConfidence',NEW."runnerUpConfidence",'kind',NEW.kind),
      COALESCE(NEW.provenance->>'inputFingerprint',NEW."financeReviewFingerprint"),
      CASE WHEN NEW.model = 'unknown' THEN NULL ELSE jsonb_build_object('kind','model','model',NEW.model,'revision',NULL,'runId',NEW."runId",'evaluationId',NEW."evaluationId") END,
      jsonb_build_object('currentValue',NEW."currentValue",'provenance',NEW.provenance),
      NEW."pairKey" IS NULL OR EXISTS(SELECT 1 FROM "Run" r WHERE r.id=NEW."runId" AND r."deletedAt" IS NULL AND r.input->>'decisionModel'=NEW.model), NEW."createdAt");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public."AiAnalysis" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityKind" text NOT NULL,
    "entityId" uuid,
    feature text NOT NULL,
    provider text,
    "resultSchemaRevision" integer,
    runtime jsonb,
    model text NOT NULL,
    "promptVersion" text NOT NULL,
    "inputFingerprint" text NOT NULL,
    result jsonb NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "AiAnalysis_entityKind_check" CHECK (("entityKind" = ANY (ARRAY['image'::text, 'location'::text, 'product'::text, 'recipe'::text, 'global'::text]))),
    CONSTRAINT "AiAnalysis_global_check" CHECK ((("entityKind" = 'global'::text) = ("entityId" IS NULL)))
);

CREATE TABLE public."AiEvaluation" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    "workKey" text NOT NULL,
    feature text NOT NULL,
    target jsonb NOT NULL,
    provenance jsonb NOT NULL,
    snapshot jsonb NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "runAttempt" integer DEFAULT 0 NOT NULL,
    "attemptToken" uuid,
    "deadlineAt" timestamp without time zone,
    "nextAttemptAt" timestamp without time zone,
    result jsonb,
    receipt jsonb,
    error text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "shareKey" text,
    "executionKind" text DEFAULT 'ai_refresh'::text NOT NULL,
    restarts integer DEFAULT 0 NOT NULL,
    CONSTRAINT "AiEvaluation_execution_kind_check" CHECK (("executionKind" = ANY (ARRAY['ai_refresh'::text, 'mail_reclassify'::text, 'suggestion_sweep'::text, 'mail_discovery'::text]))),
    CONSTRAINT "AiEvaluation_state_check" CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'result_ready'::text, 'retry_wait'::text, 'completed'::text, 'blocked'::text, 'failed'::text, 'obsolete'::text, 'cancelled'::text])))
);

CREATE TABLE public."AiEvaluationRequest" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    "evaluationId" uuid NOT NULL,
    sequence integer DEFAULT 0 NOT NULL,
    "cancelledAt" timestamp without time zone,
    receipt jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."AiUsage" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    operation text NOT NULL,
    "runId" uuid NOT NULL,
    "jobKind" text,
    "jobId" text,
    "inputTokens" integer,
    "outputTokens" integer,
    "cacheReadTokens" integer,
    "cacheWriteTokens" integer,
    attempt integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'succeeded'::text NOT NULL,
    "gatewayLogId" text,
    "durationMs" integer NOT NULL,
    "cacheStatus" text,
    "applicationCacheStatus" text,
    "entityId" uuid,
    "entityKind" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    transport text DEFAULT 'unknown'::text NOT NULL,
    "standardCost" double precision,
    "chargedCost" double precision,
    "costEvidence" jsonb,
    failure text,
    CONSTRAINT "AiUsage_transport_check" CHECK ((transport = ANY (ARRAY['gateway'::text, 'chatgpt'::text, 'direct'::text, 'cache'::text, 'unknown'::text])))
);

CREATE TABLE public."AppSettings" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    metadata jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."Assessment" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "publicationKey" text NOT NULL,
    family text NOT NULL,
    subject jsonb NOT NULL,
    judgment jsonb NOT NULL,
    fingerprint text,
    producer jsonb,
    evidence jsonb,
    origin jsonb,
    served boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."AssessmentState" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid,
    entity text NOT NULL,
    "recordId" uuid NOT NULL,
    field text DEFAULT ''::text NOT NULL,
    "financeReviewFingerprint" text,
    "evaluationId" uuid,
    provenance jsonb,
    "acceptanceReceipt" jsonb,
    "supersessionReceipt" jsonb,
    "currentValue" jsonb,
    "suggestedValue" jsonb DEFAULT 'null'::jsonb NOT NULL,
    confidence real DEFAULT 0 NOT NULL,
    "runnerUpValue" jsonb,
    "runnerUpConfidence" real,
    model text DEFAULT 'unknown'::text NOT NULL,
    "pairKey" uuid,
    kind text DEFAULT 'addition'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "correctValue" jsonb,
    family text DEFAULT 'field'::text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    fingerprint text,
    "confirmedValue" jsonb,
    suppression jsonb,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "AssessmentState_confidence_check" CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT "AssessmentState_kind_check" CHECK ((kind = ANY (ARRAY['correction'::text, 'addition'::text]))),
    CONSTRAINT "AssessmentState_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text, 'superseded'::text, 'resolved'::text])))
);

CREATE VIEW public."AssessmentEmailLink" AS
 SELECT id,
    ((data ->> 'eventId'::text))::uuid AS "eventId",
    ((data ->> 'purchaseId'::text))::uuid AS "purchaseId",
    (data ->> 'decision'::text) AS decision,
    (data ->> 'evidenceChecksum'::text) AS "evidenceChecksum",
    (data ->> 'decidedByUserId'::text) AS "decidedByUserId",
    (data ->> 'proposedBy'::text) AS "proposedBy",
    "createdAt",
    "updatedAt"
   FROM public."AssessmentState"
  WHERE ((family = 'email_link'::text) AND active);

CREATE TABLE public."AuditLog" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    action text NOT NULL,
    changes jsonb,
    "userId" text NOT NULL,
    channel text DEFAULT 'web'::text NOT NULL,
    "oauthClientId" text,
    "deviceId" uuid,
    "runId" uuid,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "AuditLog_channel_check" CHECK ((channel = ANY (ARRAY['web'::text, 'api'::text, 'mcp'::text, 'caldav'::text, 'system'::text])))
);

CREATE TABLE public."AutomaticRule" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family text NOT NULL,
    "ruleKey" text NOT NULL,
    revision text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    "enabledAt" timestamp without time zone,
    "enabledByUserId" text,
    "enabledReason" text,
    "disabledAt" timestamp without time zone,
    "disabledReason" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "AutomaticRule_family_check" CHECK ((family = ANY (ARRAY['field'::text, 'statement_transaction'::text]))),
    CONSTRAINT "AutomaticRule_key_check" CHECK ((("ruleKey" = ANY (ARRAY['field.addition'::text, 'statement_transaction.attach'::text, 'statement_transaction.book_spending'::text])) AND starts_with("ruleKey", (family || '.'::text))))
);

CREATE TABLE public."Cookbook" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    author text[] DEFAULT '{}'::text[] NOT NULL,
    subjects text[] DEFAULT '{}'::text[] NOT NULL,
    "sourceLabel" text NOT NULL,
    "rawJson" jsonb NOT NULL,
    report jsonb,
    "productId" uuid,
    "importedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."DataException" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    "check" text NOT NULL,
    reason text NOT NULL,
    note text NOT NULL,
    fingerprint text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."DerivedDiscoveryPass" (
    family text NOT NULL,
    fingerprint text NOT NULL,
    "coveredFingerprint" text,
    "runId" uuid
);

CREATE TABLE public."DerivedRefreshCaptureInbox" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    change jsonb NOT NULL,
    "inputFingerprint" text NOT NULL,
    force boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."DerivedRefreshCursor" (
    key text NOT NULL,
    cursor jsonb,
    "availableAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."DerivedRefreshFailure" (
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    phase text NOT NULL,
    fingerprint text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "lastError" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."DerivedRefreshObservedInput" (
    key text NOT NULL,
    scope text NOT NULL,
    fingerprint text NOT NULL,
    owners jsonb DEFAULT '[]'::jsonb NOT NULL,
    "seenAt" timestamp without time zone NOT NULL
);

CREATE TABLE public."DerivedRefreshPublication" (
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    phase text NOT NULL,
    revision integer NOT NULL
);

CREATE TABLE public."DerivedRefreshRevision" (
    key text NOT NULL,
    revision integer DEFAULT 0 NOT NULL
);

CREATE TABLE public."DerivedRefreshScope" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "workId" uuid NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    projected boolean DEFAULT false NOT NULL,
    traverse boolean DEFAULT true NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    phase text DEFAULT 'projection'::text NOT NULL,
    route integer DEFAULT 0 NOT NULL,
    after uuid,
    done boolean DEFAULT false NOT NULL
);

CREATE TABLE public."DerivedRefreshSnapshot" (
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    fingerprint text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."DerivedRefreshWork" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    "auditId" uuid,
    "inputFingerprint" text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    "changedFields" jsonb,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "hasFailures" boolean DEFAULT false NOT NULL,
    "leaseToken" uuid,
    "leaseExpiresAt" timestamp without time zone,
    publishing boolean DEFAULT false NOT NULL,
    "publishAfter" uuid,
    "lastError" text,
    "availableAt" timestamp without time zone DEFAULT now() NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."Device" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "installationId" text NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    "appVersion" text,
    "osVersion" text,
    "lastSeenAt" timestamp without time zone,
    "automaticWork" boolean DEFAULT true NOT NULL,
    "remotePaused" boolean DEFAULT false NOT NULL,
    "ledgerPartyId" uuid,
    "productId" uuid,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "Device_platform_check" CHECK ((platform = ANY (ARRAY['ios'::text, 'macos'::text])))
);

CREATE TABLE public."Email" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    provider text DEFAULT 'gmail'::text NOT NULL,
    "mailboxId" text NOT NULL,
    "messageId" text NOT NULL,
    checksum text NOT NULL,
    classification text,
    "classificationVersion" text,
    status text NOT NULL,
    "orderMailId" uuid,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "runId" uuid,
    "classificationStage" text,
    "classificationReason" text,
    shortcode text NOT NULL,
    sender text,
    subject text,
    "receivedAt" timestamp without time zone,
    "threadId" text,
    "historyId" text,
    "deletedAt" timestamp without time zone,
    "executionPolicy" text,
    "searchOrigin" text,
    "searchExpiresAt" timestamp without time zone,
    "contentClearedAt" timestamp without time zone,
    CONSTRAINT "Email_classification_check" CHECK ((classification = ANY (ARRAY['related'::text, 'unrelated'::text, 'uncertain'::text]))),
    CONSTRAINT "Email_classification_stage_check" CHECK ((("classificationStage" IS NULL) OR ("classificationStage" = ANY (ARRAY['rule'::text, 'decision'::text, 'model'::text, 'resolution'::text])))),
    CONSTRAINT "Email_executionPolicy_check" CHECK ((("executionPolicy" IS NULL) OR ("executionPolicy" = ANY (ARRAY['classification_only'::text, 'import'::text])))),
    CONSTRAINT "Email_searchOrigin_check" CHECK ((("searchOrigin" IS NULL) OR ("searchOrigin" = ANY (ARRAY['member_search'::text, 'discovery'::text])))),
    CONSTRAINT "Email_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'researching'::text, 'completed'::text, 'blocked'::text, 'deleted'::text, 'excluded'::text])))
);

CREATE TABLE public."EmailAccuracyEvaluation" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ownerUserId" text NOT NULL,
    "requestedSampleSize" integer NOT NULL,
    "populationCount" integer NOT NULL,
    "sampleSize" integer NOT NULL,
    roster jsonb NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "EmailAccuracyEvaluation_size_check" CHECK ("EmailAccuracyEvaluation"."requestedSampleSize" BETWEEN 1 AND 1000 AND "EmailAccuracyEvaluation"."populationCount" >= 0 AND "EmailAccuracyEvaluation"."sampleSize" BETWEEN 0 AND "EmailAccuracyEvaluation"."requestedSampleSize" AND "EmailAccuracyEvaluation"."sampleSize" <= "EmailAccuracyEvaluation"."populationCount")
);

CREATE TABLE public."EmailCandidateObservation" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "emailId" uuid NOT NULL,
    "runId" uuid,
    preview jsonb NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."EmailClassificationObservation" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "emailId" uuid NOT NULL,
    "runId" uuid,
    checksum text,
    classification text NOT NULL,
    stage text,
    reason text,
    "classificationVersion" text,
    model text,
    "usageId" uuid,
    conflict jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "promptVersion" text,
    operation text,
    provenance jsonb,
    "evaluationId" uuid,
    CONSTRAINT "EmailClassificationObservation_classification_check" CHECK ((classification = ANY (ARRAY['related'::text, 'unrelated'::text, 'uncertain'::text]))),
    CONSTRAINT "EmailClassificationObservation_operation_check" CHECK ((operation = ANY (ARRAY['mailbox-triage'::text, 'mailbox-relevance'::text]))),
    CONSTRAINT "EmailClassificationObservation_stage_check" CHECK ((stage = ANY (ARRAY['rule'::text, 'decision'::text, 'model'::text, 'resolution'::text])))
);

CREATE TABLE public."EmailFinancialAssociation" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "emailId" uuid NOT NULL,
    "evidenceChecksum" text NOT NULL,
    "transactionId" uuid NOT NULL,
    "reviewedAccountId" uuid NOT NULL,
    "sourceAccountLabel" text NOT NULL,
    "reviewReason" text NOT NULL,
    "decidedByUserId" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "EmailFinancialAssociation_evidenceChecksum_check" CHECK ((length(btrim("evidenceChecksum")) > 0)),
    CONSTRAINT "EmailFinancialAssociation_reviewReason_check" CHECK ((length(btrim("reviewReason")) > 0)),
    CONSTRAINT "EmailFinancialAssociation_sourceAccountLabel_check" CHECK ((length(btrim("sourceAccountLabel")) > 0))
);

CREATE TABLE public."EmailRetrievalFailure" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "emailId" uuid NOT NULL,
    "runId" uuid,
    "httpStatus" integer,
    error text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "EmailRetrievalFailure_httpStatus_check" CHECK ((("httpStatus" >= 100) AND ("httpStatus" <= 599)))
);

CREATE TABLE public."Entity" (
    id uuid NOT NULL,
    kind text NOT NULL,
    shortcode text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "mergedIntoId" uuid,
    CONSTRAINT "Entity_kind_check" CHECK ((kind = ANY (ARRAY['product'::text, 'recipe'::text, 'ingredient'::text, 'cookbook'::text, 'location'::text, 'inventory'::text, 'meal'::text, 'ledgerParty'::text, 'ledgerTransfer'::text, 'project'::text, 'task'::text, 'vendor'::text, 'purchase'::text, 'financialAccount'::text, 'financialTransaction'::text, 'wish'::text, 'expense'::text, 'image'::text, 'planting'::text, 'gardenEntry'::text, 'vendorAccount'::text, 'productCategory'::text, 'run'::text, 'device'::text, 'plant'::text, 'spendingCategory'::text, 'email'::text, 'imageJob'::text]))),
    CONSTRAINT "Entity_live_has_shortcode_check" CHECK ((("deletedAt" IS NOT NULL) OR (shortcode IS NOT NULL))),
    CONSTRAINT "Entity_merge_not_self_check" CHECK ((("mergedIntoId" IS NULL) OR ("mergedIntoId" <> id))),
    CONSTRAINT "Entity_merged_is_deleted_check" CHECK ((("mergedIntoId" IS NULL) OR ("deletedAt" IS NOT NULL))),
    CONSTRAINT "Entity_shortcode_prefix_check" CHECK (((shortcode IS NULL) OR
CASE kind
    WHEN 'product'::text THEN (shortcode ~~ 'PRD-%'::text)
    WHEN 'recipe'::text THEN (shortcode ~~ 'RCP-%'::text)
    WHEN 'ingredient'::text THEN (shortcode ~~ 'ING-%'::text)
    WHEN 'cookbook'::text THEN (shortcode ~~ 'CKB-%'::text)
    WHEN 'location'::text THEN (shortcode ~~ 'LOC-%'::text)
    WHEN 'inventory'::text THEN (shortcode ~~ 'INV-%'::text)
    WHEN 'meal'::text THEN (shortcode ~~ 'MEL-%'::text)
    WHEN 'ledgerParty'::text THEN (shortcode ~~ 'LPY-%'::text)
    WHEN 'ledgerTransfer'::text THEN (shortcode ~~ 'LTR-%'::text)
    WHEN 'project'::text THEN (shortcode ~~ 'PRJ-%'::text)
    WHEN 'task'::text THEN (shortcode ~~ 'TSK-%'::text)
    WHEN 'vendor'::text THEN (shortcode ~~ 'VEN-%'::text)
    WHEN 'purchase'::text THEN (shortcode ~~ 'PUR-%'::text)
    WHEN 'financialAccount'::text THEN (shortcode ~~ 'FAC-%'::text)
    WHEN 'financialTransaction'::text THEN (shortcode ~~ 'FTX-%'::text)
    WHEN 'wish'::text THEN (shortcode ~~ 'WSH-%'::text)
    WHEN 'expense'::text THEN (shortcode ~~ 'EXP-%'::text)
    WHEN 'image'::text THEN (shortcode ~~ 'IMG-%'::text)
    WHEN 'planting'::text THEN (shortcode ~~ 'PLT-%'::text)
    WHEN 'gardenEntry'::text THEN (shortcode ~~ 'GDE-%'::text)
    WHEN 'vendorAccount'::text THEN (shortcode ~~ 'VACCT-%'::text)
    WHEN 'productCategory'::text THEN (shortcode ~~ 'CAT-%'::text)
    WHEN 'run'::text THEN (shortcode ~~ 'RUN-%'::text)
    WHEN 'device'::text THEN (shortcode ~~ 'DEV-%'::text)
    WHEN 'plant'::text THEN (shortcode ~~ 'PLANT-%'::text)
    WHEN 'spendingCategory'::text THEN (shortcode ~~ 'SPC-%'::text)
    WHEN 'email'::text THEN (shortcode ~~ 'EML-%'::text)
    WHEN 'imageJob'::text THEN (shortcode ~~ 'IPR-%'::text)
    ELSE false
END))
);

CREATE TABLE public."EntityAttachment" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    "imageId" uuid NOT NULL,
    role text DEFAULT 'attachment'::text NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    purpose text,
    "documentKind" text,
    "idempotencyKey" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "EntityAttachment_documentKind_kind_check" CHECK ((("documentKind" IS NULL) OR ("entityKind" = 'purchase'::text))),
    CONSTRAINT "EntityAttachment_purpose_check" CHECK (((purpose IS NULL) OR (purpose = ANY (ARRAY['item'::text, 'label'::text])))),
    CONSTRAINT "EntityAttachment_purpose_kind_check" CHECK (((purpose IS NOT NULL) = ("entityKind" = 'product'::text))),
    CONSTRAINT "EntityAttachment_role_check" CHECK ((role = ANY (ARRAY['attachment'::text, 'cover'::text, 'logo'::text])))
);

CREATE TABLE public."EntityEmbedding" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    "embeddingText" text NOT NULL,
    "embeddingHash" text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    dimensions integer NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "artifactState" text DEFAULT 'legacy'::text NOT NULL,
    "artifactHash" text,
    "vectorHash" text,
    "submissionId" text,
    "observedAt" timestamp without time zone,
    "indexedAt" timestamp without time zone,
    "deletionId" text,
    "availableAt" timestamp without time zone DEFAULT now() NOT NULL,
    "leaseToken" uuid,
    "leaseExpiresAt" timestamp without time zone,
    "visibilityAttempts" integer DEFAULT 0 NOT NULL,
    "lastError" text
);

CREATE TABLE public."EntityExternalId" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    source text NOT NULL,
    kind text NOT NULL,
    "externalId" text NOT NULL,
    url text,
    "isPrimary" boolean,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "EntityExternalId_gtin_check" CHECK (((kind <> 'gtin_14'::text) OR ("externalId" ~ '^[0-9]{14}$'::text))),
    CONSTRAINT "EntityExternalId_kind_check" CHECK (("entityKind", "kind") IN (('product', 'asin'), ('product', 'retailer_sku'), ('product', 'internet_number'), ('product', 'item_number'), ('product', 'catalog_number'), ('product', 'manufacturer_part'), ('product', 'gtin_14'), ('financialTransaction', 'settlement_ref'), ('expense', 'page'), ('task', 'page'), ('project', 'page'), ('recipe', 'page'), ('project', 'folder'))),
    CONSTRAINT "EntityExternalId_primary_check" CHECK (
CASE
    WHEN (kind = ANY (ARRAY['asin'::text, 'retailer_sku'::text, 'internet_number'::text, 'item_number'::text, 'catalog_number'::text, 'manufacturer_part'::text, 'gtin_14'::text, 'page'::text, 'folder'::text])) THEN ("isPrimary" IS NOT NULL)
    ELSE ("isPrimary" IS NULL)
END)
);

CREATE TABLE public."EntityLink" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    "fromEntityId" uuid NOT NULL,
    "fromKind" text NOT NULL,
    "toEntityId" uuid NOT NULL,
    "toKind" text NOT NULL,
    quantity integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "acquisitionConfirmed" boolean DEFAULT false NOT NULL,
    CONSTRAINT "EntityLink_acquisition_confirmed_check" CHECK (((NOT "acquisitionConfirmed") OR (kind = 'purchaseProduct'::text))),
    CONSTRAINT "EntityLink_kind_check" CHECK (("kind", "fromKind", "toKind") IN (('wishCandidate', 'wish', 'product'), ('purchaseProduct', 'purchase', 'product'), ('purchasePaymentAccount', 'purchase', 'financialAccount'), ('projectTool', 'project', 'product'), ('gardenEntryPlanting', 'gardenEntry', 'planting'), ('productComponent', 'product', 'product'), ('taskDependency', 'task', 'task'), ('projectDependency', 'project', 'project'))),
    CONSTRAINT "EntityLink_no_self_check" CHECK (((kind <> ALL (ARRAY['productComponent'::text, 'taskDependency'::text, 'projectDependency'::text])) OR ("fromEntityId" <> "toEntityId"))),
    CONSTRAINT "EntityLink_quantity_check" CHECK (
CASE
    WHEN (kind = 'productComponent'::text) THEN ((quantity IS NOT NULL) AND (quantity >= 1))
    ELSE (quantity IS NULL)
END)
);

CREATE TABLE public."Expense" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    cost double precision,
    date date,
    "lineKind" text DEFAULT 'unclassified'::text NOT NULL,
    "lineBasis" text DEFAULT 'item_line'::text NOT NULL,
    "costType" text NOT NULL,
    trade text,
    url text,
    notes text,
    future boolean DEFAULT false NOT NULL,
    "projectId" uuid,
    "productId" uuid,
    "productQuantity" double precision,
    "purchaseId" uuid,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "spendingCategoryId" uuid,
    "economicRole" text DEFAULT 'vendor'::text NOT NULL,
    "bookingTransactionCode" text,
    CONSTRAINT "Expense_classification_lineBasis_productId_check" CHECK ((("lineBasis" <> 'allocation'::text) OR ("productId" IS NULL))),
    CONSTRAINT "Expense_classification_lineKind_productId_check" CHECK ((("lineKind" <> ALL (ARRAY['unclassified'::text, 'tax'::text, 'shipping'::text, 'discount'::text, 'fee'::text, 'tip'::text, 'other_adjustment'::text])) OR ("productId" IS NULL))),
    CONSTRAINT "Expense_classification_lineKind_projectId_check" CHECK ((("lineKind" <> ALL (ARRAY['unclassified'::text, 'tax'::text, 'shipping'::text, 'discount'::text, 'fee'::text, 'tip'::text, 'other_adjustment'::text])) OR ("projectId" IS NULL))),
    CONSTRAINT "Expense_classification_lineKind_spendingCategoryId_check" CHECK ((("lineKind" <> ALL (ARRAY['unclassified'::text, 'tax'::text, 'shipping'::text, 'discount'::text, 'fee'::text, 'tip'::text, 'other_adjustment'::text])) OR ("spendingCategoryId" IS NULL))),
    CONSTRAINT "Expense_cost_whole_cent_check" CHECK (((cost IS NULL) OR (abs(((cost * (100)::double precision) - round((cost * (100)::double precision)))) < (0.0000001)::double precision))),
    CONSTRAINT "Expense_date_cost_check" CHECK (((date IS NOT NULL) OR (cost IS NULL) OR (cost = (0)::double precision))),
    CONSTRAINT "Expense_lineKind_productId_check" CHECK ((("lineKind" = 'principal'::text) OR ("productId" IS NULL))),
    CONSTRAINT "Expense_live_charge_assignment_check" CHECK ((("deletedAt" IS NOT NULL) OR ("lineKind" = ANY (ARRAY['principal'::text, 'unclassified'::text])) OR (("projectId" IS NULL) AND ("purchaseId" IS NOT NULL)))),
    CONSTRAINT "Expense_productQuantity_check" CHECK ((("productQuantity" IS NULL) OR (("productId" IS NOT NULL) AND (("productQuantity" <> (0)::double precision) OR ((cost IS NOT NULL) AND (cost < (0)::double precision))))))
);

CREATE TABLE public."ExpenseAttribution" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "expenseId" uuid NOT NULL,
    role text NOT NULL,
    "ledgerPartyId" uuid,
    weight bigint NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "ExpenseAttribution_role_check" CHECK ((role = ANY (ARRAY['beneficiary'::text, 'funder'::text]))),
    CONSTRAINT "ExpenseAttribution_weight_check" CHECK (((weight > 0) AND (weight <= '9007199254740991'::bigint)))
);

CREATE TABLE public."ExternalSource" (
    slug text NOT NULL,
    label text NOT NULL,
    "vendorId" uuid,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    issuer boolean DEFAULT false NOT NULL,
    CONSTRAINT "ExternalSource_slug_check" CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))
);

CREATE TABLE public."Feedback" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "assessmentId" uuid NOT NULL,
    "operationId" text NOT NULL,
    verdict text NOT NULL,
    correction jsonb NOT NULL,
    reason text,
    evidence jsonb,
    intent text NOT NULL,
    authority text NOT NULL,
    "actorUserId" text,
    suppression jsonb,
    receipt jsonb,
    metadata jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Feedback_authority_check" CHECK ((authority = ANY (ARRAY['member'::text, 'evaluation'::text, 'automatic'::text, 'unknown'::text]))),
    CONSTRAINT "Feedback_verdict_check" CHECK ((verdict = ANY (ARRAY['correct'::text, 'wrong'::text, 'uncertain'::text, 'dismissed'::text, 'ungraded'::text])))
);

CREATE TABLE public."FinancialAccount" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    identity jsonb NOT NULL,
    provisional boolean DEFAULT false NOT NULL,
    "sourceAliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "cardNumbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "providerVendorId" uuid,
    "ledgerPartyId" uuid,
    "inventoryOwnerDefaultEnabled" boolean DEFAULT false NOT NULL,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "primaryCardholderId" uuid,
    "authorizedUsers" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "fundingPeriods" jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT "FinancialAccount_providerVendor_stored_value_check" CHECK ((("providerVendorId" IS NULL) OR ((identity ->> 'kind'::text) = 'stored_value'::text)))
);

CREATE TABLE public."FinancialTransaction" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "accountId" uuid NOT NULL,
    "ledgerTransferId" uuid,
    kind text NOT NULL,
    status text NOT NULL,
    amount double precision NOT NULL,
    "transactionDate" date,
    "postedDate" date,
    merchant text,
    "rawDescription" text,
    "sourceCategory" text,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "spendingCategoryId" uuid,
    "itemizationExpectation" text,
    "bookingDecisionFingerprint" text,
    "bookingExpenseFingerprint" text,
    "bookingCorrectionReceipt" jsonb,
    CONSTRAINT "FinancialTransaction_amount_whole_cent_check" CHECK (((amount <> (0)::double precision) AND (abs(((amount * (100)::double precision) - round((amount * (100)::double precision)))) < (0.0000001)::double precision))),
    CONSTRAINT "FinancialTransaction_posted_date_check" CHECK (((status <> 'posted'::text) OR ("postedDate" IS NOT NULL)))
);

CREATE TABLE public."FinancialTransactionAllocation" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "transactionId" uuid NOT NULL,
    "purchaseId" uuid NOT NULL,
    amount double precision NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "FinancialTransactionAllocation_amount_whole_cent_check" CHECK (((amount <> (0)::double precision) AND (abs(((amount * (100)::double precision) - round((amount * (100)::double precision)))) < (0.0000001)::double precision)))
);

CREATE TABLE public."GardenEntry" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "locationId" uuid NOT NULL,
    kind text DEFAULT 'note'::text NOT NULL,
    "observedOn" date NOT NULL,
    notes text,
    "harvestAmount" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."Image" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    key text NOT NULL,
    filename text NOT NULL,
    size integer NOT NULL,
    "contentType" text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    width integer,
    height integer,
    "perceptualHash" text,
    "sourceFingerprint" jsonb,
    "detectedContentType" text,
    sha256 text,
    "renderStatus" text,
    "storageStatus" text,
    source text DEFAULT 'unknown'::text NOT NULL,
    "sourcePageUrl" text,
    "sourceAssetUrl" text,
    "sourceName" text,
    "useOriginal" boolean DEFAULT false NOT NULL,
    "verifiedAt" timestamp without time zone,
    "capturedAt" timestamp without time zone,
    "capturedAtOffsetMinutes" integer,
    "captureLocation" jsonb,
    "capturePlaceName" text,
    "captureDeviceLabel" text,
    "capturedByPartyId" uuid,
    "captureAttribution" text DEFAULT 'none'::text NOT NULL,
    "provenanceEvidence" jsonb,
    "metadataRevision" integer,
    "embeddedMetadata" jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "sourceEvidence" jsonb,
    "metadataOutcome" text,
    "metadataError" text,
    CONSTRAINT "Image_metadataOutcome_check" CHECK (("metadataOutcome" = ANY (ARRAY['original_missing'::text, 'extraction_failed'::text]))),
    CONSTRAINT "Image_perceptualHash_format_check" CHECK ((("perceptualHash" IS NULL) OR ("perceptualHash" ~ '^[0-9a-f]{16}$'::text))),
    CONSTRAINT "Image_renderStatus_check" CHECK (("renderStatus" = ANY (ARRAY['unverified'::text, 'verified'::text, 'failed'::text]))),
    CONSTRAINT "Image_status_check" CHECK ((status = ANY (ARRAY['PENDING'::text, 'UPLOADED'::text, 'FAILED'::text]))),
    CONSTRAINT "Image_storageStatus_check" CHECK (("storageStatus" = ANY (ARRAY['unverified'::text, 'available'::text, 'missing'::text, 'metadata_mismatch'::text])))
);

CREATE TABLE public."ImageDerivative" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "imageId" uuid NOT NULL,
    purpose text NOT NULL,
    status text NOT NULL,
    key text NOT NULL,
    "sourceContentHash" text NOT NULL,
    "processorRevision" integer NOT NULL,
    "contentType" text,
    sha256 text,
    width integer,
    height integer,
    "failureReason" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "ImageDerivative_purpose_check" CHECK ((purpose = 'transparent'::text)),
    CONSTRAINT "ImageDerivative_ready_metadata_check" CHECK (((status <> 'ready'::text) OR (("contentType" IS NOT NULL) AND ("contentType" = 'image/png'::text) AND (sha256 IS NOT NULL) AND (width IS NOT NULL) AND (width > 0) AND (height IS NOT NULL) AND (height > 0)))),
    CONSTRAINT "ImageDerivative_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'skipped'::text, 'failed'::text, 'abandoned'::text])))
);

CREATE TABLE public."ImageProcessingAttempt" (
    id uuid NOT NULL,
    "jobId" uuid NOT NULL,
    number integer NOT NULL,
    "submissionId" uuid,
    "inputKey" text,
    state text NOT NULL,
    executor jsonb,
    "assignedUserId" text,
    "assignedConnectionId" text,
    diagnostics jsonb,
    result jsonb,
    error text,
    "startedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "completedAt" timestamp without time zone,
    CONSTRAINT "ImageProcessingAttempt_number_check" CHECK ((number > 0)),
    CONSTRAINT "ImageProcessingAttempt_state_check" CHECK ((state = ANY (ARRAY['leased'::text, 'running'::text, 'waiting'::text, 'expired'::text, 'ready'::text, 'skipped'::text, 'failed'::text])))
);

CREATE TABLE public."ImageProcessingEvent" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "jobId" uuid NOT NULL,
    "eventKey" text NOT NULL,
    attempt integer,
    event text NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    source text DEFAULT 'server'::text NOT NULL,
    details jsonb,
    "occurredAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."ImageProcessingJob" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "imageId" uuid NOT NULL,
    "derivativeId" uuid,
    kind text NOT NULL,
    state text NOT NULL,
    "sourceContentHash" text NOT NULL,
    "processorRevision" integer NOT NULL,
    "submissionId" uuid,
    "runId" uuid,
    "attemptId" uuid,
    "leaseExpiresAt" timestamp without time zone,
    attempts integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp without time zone DEFAULT now() NOT NULL,
    "dispatchedAt" timestamp without time zone,
    "completedAt" timestamp without time zone,
    "lastError" text,
    runtime jsonb,
    result jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    shortcode text NOT NULL,
    "deletedAt" timestamp without time zone,
    "failuresSinceRetry" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "ImageProcessingJob_attempts_check" CHECK ((attempts >= 0)),
    CONSTRAINT "ImageProcessingJob_kind_check" CHECK ((kind = ANY (ARRAY['subject_lift'::text, 'describe_image'::text, 'identify_image'::text]))),
    CONSTRAINT "ImageProcessingJob_lease_check" CHECK (((state = 'leased'::text) = (("attemptId" IS NOT NULL) AND ("leaseExpiresAt" IS NOT NULL)))),
    CONSTRAINT "ImageProcessingJob_state_check" CHECK ((state = ANY (ARRAY['pending'::text, 'waiting_for_device'::text, 'leased'::text, 'ready'::text, 'skipped'::text, 'failed'::text])))
);

CREATE TABLE public."ImageProcessingOrphan" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    "attemptId" uuid,
    reason text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."ImageProcessingSubmission" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "publicId" text DEFAULT ('IPS-'::text || upper(replace((gen_random_uuid())::text, '-'::text, ''::text))) NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."ImageProcessingSubmissionJob" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "submissionId" uuid NOT NULL,
    "jobId" uuid NOT NULL,
    disposition text NOT NULL,
    "baselineAttempts" integer NOT NULL,
    CONSTRAINT "ImageProcessingSubmissionJob_baseline_check" CHECK (("baselineAttempts" >= 0)),
    CONSTRAINT "ImageProcessingSubmissionJob_disposition_check" CHECK ((disposition = ANY (ARRAY['new'::text, 'reused'::text, 'running'::text, 'retry'::text])))
);

CREATE TABLE public."ImageSighting" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "imageId" uuid NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    "deviceId" uuid NOT NULL,
    "assetKey" text NOT NULL,
    "cloudIdentifier" text,
    "localIdentifier" text,
    "sourceType" text NOT NULL,
    "mediaSubtypes" text[] DEFAULT '{}'::text[] NOT NULL,
    "originalFilename" text,
    "pixelWidth" integer,
    "pixelHeight" integer,
    "hasAdjustments" boolean DEFAULT false NOT NULL,
    "capturedAt" timestamp without time zone,
    "capturedAtOffsetMinutes" integer,
    "addedAt" timestamp without time zone,
    location jsonb,
    "placeName" text,
    camera jsonb,
    "matchKind" text NOT NULL,
    "hashDistance" integer,
    "aspectGate" boolean,
    "observedAt" timestamp without time zone NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "ImageSighting_matchKind_check" CHECK (("matchKind" = ANY (ARRAY['import'::text, 'libraryMatch'::text]))),
    CONSTRAINT "ImageSighting_sourceType_check" CHECK (("sourceType" = ANY (ARRAY['userLibrary'::text, 'cloudShared'::text, 'iTunesSynced'::text])))
);

CREATE TABLE public."ImportPreparedLine" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "preparedOrderId" uuid NOT NULL,
    "stableLineId" text NOT NULL,
    "position" integer NOT NULL,
    line jsonb NOT NULL,
    identifiers jsonb NOT NULL,
    candidates jsonb NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."ImportPreparedOrder" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    "prepareOperationId" text NOT NULL,
    "itemOperationId" text NOT NULL,
    "stableOrderId" text NOT NULL,
    "sourceKind" text NOT NULL,
    "sourceExternalKey" text NOT NULL,
    "sourceChecksum" text NOT NULL,
    "evidenceChecksum" text NOT NULL,
    "extractionRevision" text NOT NULL,
    extraction jsonb NOT NULL,
    "primaryDocumentImageId" uuid,
    "screenshotImageId" uuid,
    "targetFingerprint" text NOT NULL,
    "evidenceFingerprint" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "targetPurchaseId" uuid,
    "vendorId" uuid,
    CONSTRAINT "ImportPreparedOrder_source_kind_check" CHECK (("sourceKind" = ANY (ARRAY['browser_order'::text, 'mail_message'::text, 'mail_attachment'::text, 'receipt_photo'::text, 'vendor_export'::text])))
);

CREATE TABLE public."ImportSourceClaim" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    "vendorAccountId" uuid,
    kind text NOT NULL,
    "externalKey" text NOT NULL,
    checksum text NOT NULL,
    "firstRunId" uuid NOT NULL,
    "lastRunId" uuid NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "canonicalClaimId" uuid,
    CONSTRAINT "ImportSourceClaim_canonical_self_check" CHECK ((("canonicalClaimId" IS NULL) OR ("canonicalClaimId" <> id))),
    CONSTRAINT "ImportSourceClaim_kind_check" CHECK ((kind = ANY (ARRAY['browser_order'::text, 'mail_message'::text, 'mail_attachment'::text, 'receipt_photo'::text, 'vendor_export'::text])))
);

CREATE TABLE public."ImportSourceOrder" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "sourceClaimId" uuid NOT NULL,
    "orderKey" text NOT NULL,
    "purchaseId" uuid,
    checksum text NOT NULL,
    "outputFingerprint" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "originalOrder" jsonb,
    "acceptedObservationId" uuid
);

CREATE TABLE public."ImportSourceProduct" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "sourceOrderId" uuid NOT NULL,
    "lineIndex" integer NOT NULL,
    "productId" uuid NOT NULL,
    CONSTRAINT "ImportSourceProduct_lineIndex_check" CHECK (("lineIndex" >= 0))
);

CREATE TABLE public."Ingredient" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    "naKinds" text[] DEFAULT '{}'::text[] NOT NULL,
    "usuallyOnHand" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "recipeId" uuid
);

CREATE TABLE public."InventoryEntry" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "productId" uuid NOT NULL,
    "amountValue" double precision NOT NULL,
    "amountUnit" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "locationId" uuid NOT NULL,
    "verifiedAt" timestamp without time zone,
    placement text DEFAULT 'stock'::text NOT NULL,
    "ownershipMode" text DEFAULT 'inherit'::text NOT NULL,
    "ownerLedgerPartyId" uuid,
    CONSTRAINT "InventoryEntry_ownershipMode_check" CHECK (("ownershipMode" = ANY (ARRAY['inherit'::text, 'explicit'::text]))),
    CONSTRAINT "InventoryEntry_ownership_valid" CHECK ((("ownershipMode" = 'explicit'::text) OR ("ownerLedgerPartyId" IS NULL))),
    CONSTRAINT "InventoryEntry_placement_check" CHECK ((placement = ANY (ARRAY['stock'::text, 'installed'::text])))
);

CREATE TABLE public."LedgerParty" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "userId" text,
    CONSTRAINT "LedgerParty_kind_check" CHECK ((kind = ANY (ARRAY['member'::text, 'guest'::text, 'household'::text]))),
    CONSTRAINT "LedgerParty_user_member_check" CHECK ((("userId" IS NULL) OR (kind = 'member'::text)))
);

CREATE TABLE public."LedgerSourceClaim" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "expenseId" uuid,
    "ledgerTransferId" uuid,
    source text NOT NULL,
    "sourceKey" text NOT NULL,
    "sourceKeyVersion" integer NOT NULL,
    "normalizedEvidence" jsonb NOT NULL,
    "targetAmountAtClaim" double precision NOT NULL,
    "reconciliationDecision" text NOT NULL,
    "reconciliationNote" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "LedgerSourceClaim_owner_check" CHECK ((("expenseId" IS NOT NULL) <> ("ledgerTransferId" IS NOT NULL))),
    CONSTRAINT "LedgerSourceClaim_reconciliation_check" CHECK (((abs((("targetAmountAtClaim" * (100)::double precision) - round(("targetAmountAtClaim" * (100)::double precision)))) < (0.0000001)::double precision) AND (abs((((("normalizedEvidence" ->> 'amount'::text))::double precision * (100)::double precision) - round(((("normalizedEvidence" ->> 'amount'::text))::double precision * (100)::double precision)))) < (0.0000001)::double precision) AND ((("reconciliationDecision" = 'amounts_match'::text) AND ("reconciliationNote" IS NULL) AND (abs(((("normalizedEvidence" ->> 'amount'::text))::double precision - "targetAmountAtClaim")) < (0.0000001)::double precision)) OR (("reconciliationDecision" = 'accept_target_amount'::text) AND (length(TRIM(BOTH FROM "reconciliationNote")) > 0) AND (abs(((("normalizedEvidence" ->> 'amount'::text))::double precision - "targetAmountAtClaim")) >= (0.0000001)::double precision))))),
    CONSTRAINT "LedgerSourceClaim_sourceKeyVersion_check" CHECK (("sourceKeyVersion" > 0)),
    CONSTRAINT "LedgerSourceClaim_source_check" CHECK (((source ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (source = lower(TRIM(BOTH FROM source)))))
);

CREATE TABLE public."LedgerTransfer" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "fromPartyId" uuid NOT NULL,
    "toPartyId" uuid NOT NULL,
    amount double precision NOT NULL,
    date date NOT NULL,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "LedgerTransfer_amount_whole_cent_check" CHECK (((amount > (0)::double precision) AND (abs(((amount * (100)::double precision) - round((amount * (100)::double precision)))) < (0.0000001)::double precision)))
);

CREATE TABLE public."Location" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "lastBulkInventory" timestamp without time zone,
    "parentId" uuid,
    "productId" uuid,
    type text NOT NULL,
    notes text,
    CONSTRAINT "Location_classification_type_productId_check" CHECK (((type <> 'furniture'::text) OR ("productId" IS NOT NULL)))
);

CREATE TABLE public."MailboxCursor" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    provider text DEFAULT 'gmail'::text NOT NULL,
    "historyId" text,
    "lastPolledAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "mailboxId" text NOT NULL,
    coverage jsonb
);

CREATE TABLE public."McpToolCall" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "toolName" text NOT NULL,
    outcome text NOT NULL,
    "registeredAtCall" boolean NOT NULL,
    surface text NOT NULL,
    "entityKind" text,
    release text NOT NULL,
    "occurredAt" timestamp without time zone NOT NULL,
    "ingestedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "userId" text NOT NULL,
    "clientId" text,
    "runId" uuid
);

CREATE TABLE public."Meal" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    date date NOT NULL,
    name text,
    "sortOrder" integer,
    "mealType" text,
    "mealKind" text DEFAULT 'cooked'::text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."MealFoodEntry" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "mealId" uuid NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    "sourceKind" text NOT NULL,
    "ingredientId" uuid,
    "productId" uuid,
    "amountValue" double precision,
    "amountUnit" text,
    name text,
    nutrients jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "MealFoodEntry_amount_check" CHECK (((("amountValue" IS NULL) AND ("amountUnit" IS NULL)) OR (("amountValue" IS NOT NULL) AND ("amountUnit" IS NOT NULL) AND ("amountValue" > (0)::double precision) AND ("amountValue" < 'Infinity'::double precision) AND (length(TRIM(BOTH FROM "amountUnit")) > 0) AND ("amountUnit" = TRIM(BOTH FROM "amountUnit"))))),
    CONSTRAINT "MealFoodEntry_source_check" CHECK (((("sourceKind" = 'ingredient'::text) AND ("ingredientId" IS NOT NULL) AND ("productId" IS NULL) AND ("amountValue" IS NOT NULL) AND (name IS NULL) AND (nutrients IS NULL)) OR (("sourceKind" = 'product'::text) AND ("ingredientId" IS NULL) AND ("productId" IS NOT NULL) AND ("amountValue" IS NOT NULL) AND (name IS NULL) AND (nutrients IS NULL)) OR (("sourceKind" = 'manual'::text) AND ("ingredientId" IS NULL) AND ("productId" IS NULL) AND (length(TRIM(BOTH FROM name)) > 0) AND (name IS NOT NULL) AND (nutrients IS NOT NULL) AND (jsonb_typeof(nutrients) = 'object'::text) AND (nutrients <> '{}'::jsonb))))
);

CREATE TABLE public."MealRecipe" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "mealId" uuid NOT NULL,
    "recipeId" uuid NOT NULL,
    scale real DEFAULT 1 NOT NULL,
    "sortOrder" integer,
    "estimatedYieldGrams" integer,
    "actualYieldGrams" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "MealRecipe_actualYieldGrams_check" CHECK ((("actualYieldGrams" IS NULL) OR ("actualYieldGrams" > 0))),
    CONSTRAINT "MealRecipe_estimatedYieldGrams_check" CHECK ((("estimatedYieldGrams" IS NULL) OR ("estimatedYieldGrams" > 0)))
);

CREATE TABLE public."MealRecipePortion" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "mealRecipeId" uuid NOT NULL,
    "mealId" uuid NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    "amountValue" double precision NOT NULL,
    "amountUnit" text NOT NULL,
    "confirmedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "MealRecipePortion_amount_check" CHECK (((("amountValue" IS NULL) AND ("amountUnit" IS NULL)) OR (("amountValue" IS NOT NULL) AND ("amountUnit" IS NOT NULL) AND ("amountValue" > (0)::double precision) AND ("amountValue" < 'Infinity'::double precision) AND (length(TRIM(BOTH FROM "amountUnit")) > 0) AND ("amountUnit" = TRIM(BOTH FROM "amountUnit")))))
);

CREATE TABLE public."MerchantVendorRule" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    "normalizedMerchant" text NOT NULL,
    "vendorId" uuid NOT NULL,
    "confirmedByUserId" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."OrderMail" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    "vendorId" uuid,
    "rawChecksum" text NOT NULL,
    "classifiedChecksum" text,
    content jsonb DEFAULT '{"snippet": null, "bodyHtml": null, "bodyText": null}'::jsonb NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "hasRetainedText" boolean GENERATED ALWAYS AS ((COALESCE(NULLIF(btrim((content ->> 'snippet'::text)), ''::text), NULLIF(btrim((content ->> 'bodyText'::text)), ''::text), NULLIF(btrim((content ->> 'bodyHtml'::text)), ''::text)) IS NOT NULL)) STORED NOT NULL
);

CREATE TABLE public."OrderMailAttachment" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "orderMailId" uuid NOT NULL,
    "providerAttachmentId" text NOT NULL,
    filename text NOT NULL,
    "mimeType" text NOT NULL,
    checksum text NOT NULL,
    "pendingObjectKey" text,
    "imageId" uuid,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "pendingDeleteKeys" text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE TABLE public."OrderMailEvent" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "orderMailId" uuid NOT NULL,
    event text NOT NULL,
    "orderId" text,
    amount double precision,
    currency text,
    "occurredAt" timestamp without time zone,
    "sourceKey" text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    "supersededAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."PhotoGroupProposal" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    "groupKey" text NOT NULL,
    state text DEFAULT 'proposed'::text NOT NULL,
    images jsonb DEFAULT '[]'::jsonb NOT NULL,
    skip jsonb DEFAULT '[]'::jsonb NOT NULL,
    "productKind" text NOT NULL,
    "productId" uuid,
    "productCreate" jsonb,
    "productCreateCategoryId" uuid,
    "inventoryLocationId" uuid,
    inventory jsonb,
    "inventoryOwnerPartyId" uuid,
    evidence text,
    "conflictProductIds" jsonb,
    "lastError" text,
    "committedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    origin text,
    review jsonb,
    CONSTRAINT "PhotoGroupProposal_origin_check" CHECK (((origin IS NULL) OR (origin = ANY (ARRAY['coordinator'::text, 'external_agent'::text, 'member'::text])))),
    CONSTRAINT "PhotoGroupProposal_product_kind_check" CHECK (("productKind" = ANY (ARRAY['existing'::text, 'create'::text]))),
    CONSTRAINT "PhotoGroupProposal_state_check" CHECK ((state = ANY (ARRAY['proposed'::text, 'committed'::text, 'discarded'::text])))
);

CREATE TABLE public."PhotoRunImage" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    "imageId" uuid NOT NULL,
    "workKey" text DEFAULT ''::text NOT NULL,
    "position" integer,
    state text DEFAULT 'pending'::text NOT NULL,
    "targetFingerprint" text NOT NULL,
    outcome text,
    "skipReason" text,
    "commitReceipt" jsonb,
    "preparedAt" timestamp without time zone,
    "completedAt" timestamp without time zone,
    "deviceWorkState" text,
    "deviceWorkAttempts" integer DEFAULT 0 NOT NULL,
    "deviceWorkError" text,
    "deviceWorkDeviceId" uuid,
    "deviceWorkUpdatedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "PhotoRunImage_device_state_check" CHECK ((("deviceWorkState" IS NULL) OR ("deviceWorkState" = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'failed'::text, 'completed'::text])))),
    CONSTRAINT "PhotoRunImage_outcome_check" CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['attached'::text, 'skipped'::text])))),
    CONSTRAINT "PhotoRunImage_state_check" CHECK ((state = ANY (ARRAY['pending'::text, 'prepared'::text, 'completed'::text, 'skipped'::text, 'unresolved'::text, 'needs_evidence'::text, 'unavailable'::text])))
);

CREATE TABLE public."Plant" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    "gardenGuideKey" text,
    verdict text,
    "ingredientId" uuid,
    "latinName" text,
    breeding text,
    "daysFromSowMin" integer,
    "daysFromSowMax" integer,
    "daysFromTransplantMin" integer,
    "daysFromTransplantMax" integer,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."Planting" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "plantId" uuid NOT NULL,
    outcome text,
    "sourceProductId" uuid,
    "locationId" uuid,
    "taskId" uuid,
    status text DEFAULT 'planned'::text NOT NULL,
    quantity text,
    notes text,
    "plannedWindow" text,
    "sowedOn" date,
    "transplantedOn" date,
    "finishedOn" date,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."Product" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    manufacturer text NOT NULL,
    fdc_id integer,
    model text,
    "expectedQuantity" integer,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "ingredientId" uuid,
    "growsPlantId" uuid,
    "categoryId" uuid,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    price real,
    "usdaUnavailable" boolean,
    "stockTracked" boolean,
    "labelNutrition" jsonb,
    "acquisitionOrigin" text DEFAULT 'unknown'::text NOT NULL,
    kind text,
    commodity boolean DEFAULT false NOT NULL,
    CONSTRAINT "Product_kind_check" CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['consumable'::text, 'durable'::text]))))
);

CREATE TABLE public."ProductCategory" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    description text,
    "parentId" uuid,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    feature text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "spendingCategoryMode" text DEFAULT 'inherit'::text NOT NULL,
    "spendingCategoryId" uuid,
    emoji text,
    "stockTracked" boolean,
    CONSTRAINT "ProductCategory_feature_check" CHECK (((feature IS NULL) OR (feature = ANY (ARRAY['food'::text, 'books'::text, 'tools'::text, 'tool-consumables'::text, 'tool-accessories'::text, 'storage'::text, 'hardware'::text, 'electronics'::text, 'software'::text, 'household'::text, 'supplies'::text, 'apparel'::text])))),
    CONSTRAINT "ProductCategory_sortOrder_check" CHECK (("sortOrder" >= 0)),
    CONSTRAINT "ProductCategory_spendingCategoryMode_check" CHECK (("spendingCategoryMode" = ANY (ARRAY['inherit'::text, 'mapped'::text, 'blocked'::text]))),
    CONSTRAINT "ProductCategory_spending_mapping_check" CHECK ((("spendingCategoryMode" = 'mapped'::text) = ("spendingCategoryId" IS NOT NULL)))
);

CREATE TABLE public."ProductConversionCoverage" (
    "productId" uuid NOT NULL,
    "coverageTier" text NOT NULL,
    "coveredKinds" text[] DEFAULT '{}'::text[] NOT NULL,
    "applicableKinds" text[] DEFAULT '{}'::text[] NOT NULL,
    "islandCount" integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    "engineVersion" text NOT NULL,
    "computedAt" timestamp without time zone NOT NULL
);

CREATE TABLE public."ProductUnitMapping" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "productId" uuid NOT NULL,
    "aValue" double precision NOT NULL,
    "aUnit" text NOT NULL,
    "bValue" double precision NOT NULL,
    "bUnit" text NOT NULL,
    source text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."Project" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'planning'::text NOT NULL,
    kind text,
    locations text[] DEFAULT '{}'::text[] NOT NULL,
    "locationsMode" text DEFAULT 'inherit'::text NOT NULL,
    "defaultTrade" text,
    "costEstimate" double precision,
    "parentProjectId" uuid,
    "startDate" date,
    "endDate" date,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    emoji text,
    "assigneeId" uuid,
    "assigneeMode" text DEFAULT 'inherit'::text NOT NULL
);

CREATE TABLE public."Purchase" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "vendorId" uuid NOT NULL,
    "vendorAccountId" uuid,
    "defaultProjectId" uuid,
    "defaultTrade" text,
    "orderId" text,
    "displayLabel" text,
    date date,
    "statedTotal" double precision,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "runId" uuid,
    "spendingCategoryId" uuid,
    "itemizationExpectation" text,
    "spendingCategoryOrigin" text DEFAULT 'legacy'::text NOT NULL,
    "purchaserOverrideId" uuid,
    CONSTRAINT "Purchase_spendingCategoryOrigin_check" CHECK (("spendingCategoryOrigin" = ANY (ARRAY['legacy'::text, 'manual'::text, 'source'::text]))),
    CONSTRAINT "Purchase_statedTotal_whole_cent_check" CHECK ((("statedTotal" IS NULL) OR (abs((("statedTotal" * (100)::double precision) - round(("statedTotal" * (100)::double precision)))) < (0.0000001)::double precision)))
);

CREATE TABLE public."PurchasePaymentEvidence" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "purchaseId" uuid NOT NULL,
    "sourceClaimId" uuid NOT NULL,
    amount double precision NOT NULL,
    "chargedAt" timestamp without time zone,
    "cardLastFour" text,
    description text,
    "evidenceIndex" integer NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    tender text DEFAULT 'unknown'::text NOT NULL,
    CONSTRAINT "PurchasePaymentEvidence_tender_check" CHECK ((tender = ANY (ARRAY['card'::text, 'stored_value'::text, 'unknown'::text])))
);

CREATE TABLE public."Recipe" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "sourceType" text,
    "sourceUrl" text,
    "sourceLabel" text,
    "cookbookId" uuid,
    "forkedFromRecipeId" uuid,
    yield jsonb,
    servings integer,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    notes text,
    totals jsonb,
    "totalsComputedAt" timestamp without time zone,
    "activeMinutes" integer,
    "totalMinutes" integer,
    meta jsonb,
    CONSTRAINT "Recipe_sourceType_check" CHECK ((("sourceType" IS NULL) OR ("sourceType" = ANY (ARRAY['Book'::text, 'Website'::text, 'Other'::text, 'Notion'::text]))))
);

CREATE TABLE public."RecipeSection" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "recipeId" uuid NOT NULL,
    name text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    instructions jsonb DEFAULT '[]'::jsonb NOT NULL,
    "sortOrder" integer
);

CREATE TABLE public."RecipeSectionIngredient" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "recipeSectionId" uuid NOT NULL,
    "ingredientId" uuid NOT NULL,
    amounts jsonb DEFAULT '[]'::jsonb NOT NULL,
    "rawLine" text,
    modifier text,
    "sortOrder" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."Run" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "ledgerPartyId" uuid,
    "actorName" text NOT NULL,
    "vendorAccountId" uuid,
    "vendorId" uuid,
    purpose text DEFAULT 'account_sync'::text NOT NULL,
    trigger text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    "coordinatorModel" text DEFAULT 'gpt-6-sol'::text NOT NULL,
    "skillRevision" text DEFAULT 'purchase-import@1'::text NOT NULL,
    "runtimeRevision" text DEFAULT 'pi-durable@1'::text NOT NULL,
    "decisionRevision" integer DEFAULT 1 NOT NULL,
    "startedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "endedAt" timestamp without time zone,
    "ordersSeen" integer DEFAULT 0 NOT NULL,
    imported integer DEFAULT 0 NOT NULL,
    updated integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    "auditedAt" timestamp without time zone,
    "failureCode" text,
    notes text,
    "dispatchAttempts" integer DEFAULT 0 NOT NULL,
    "dispatchError" text,
    "coordinatorStartedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "actorUserId" text NOT NULL,
    "actorEmail" text NOT NULL,
    "actorLedgerPartyShortcode" text,
    "actorLedgerPartyName" text,
    "actorLedgerPartyKind" text,
    "predecessorRunId" uuid,
    "dispatchEventId" text,
    "agentSessionId" text,
    "historyCursorUrl" text,
    "historyExhaustedAt" timestamp without time zone,
    channel text DEFAULT 'web'::text NOT NULL,
    "oauthClientId" text,
    "deviceId" uuid,
    "clientKey" text,
    input jsonb,
    progress jsonb,
    routine boolean DEFAULT false NOT NULL,
    cause text,
    attempt integer,
    "parentRunId" uuid,
    "retiredAt" timestamp without time zone,
    "retirementReason" text,
    "liveProgress" jsonb,
    "progressHistory" jsonb,
    "progressEventIds" jsonb,
    "heartbeatAt" timestamp without time zone,
    CONSTRAINT "Run_attempt_positive" CHECK (((attempt IS NULL) OR (attempt > 0))),
    CONSTRAINT "Run_cause_check" CHECK ((cause = ANY (ARRAY['member_request'::text, 'scheduled'::text, 'source_discovered'::text, 'import_completed'::text, 'evidence_changed'::text, 'retry'::text]))),
    CONSTRAINT "Run_channel_check" CHECK ((channel = ANY (ARRAY['web'::text, 'api'::text, 'mcp'::text, 'caldav'::text, 'system'::text]))),
    CONSTRAINT "Run_import_party_check" CHECK (((purpose <> ALL (ARRAY['account_sync'::text, 'mail_import'::text, 'purchase_validation'::text, 'product_enrichment'::text, 'photo_inventory'::text, 'mail_discovery'::text])) OR (("ledgerPartyId" IS NOT NULL) AND ("actorLedgerPartyShortcode" IS NOT NULL)))),
    CONSTRAINT "Run_photo_inventory_no_vendor_check" CHECK (((purpose <> 'photo_inventory'::text) OR ("vendorAccountId" IS NULL))),
    CONSTRAINT "Run_purpose_check" CHECK ((purpose = ANY (ARRAY['account_sync'::text, 'mail_import'::text, 'purchase_validation'::text, 'product_enrichment'::text, 'photo_inventory'::text, 'ai_suggest'::text, 'suggestion_sweep'::text, 'ai_refresh'::text, 'background'::text, 'file_import'::text, 'mail_search'::text, 'mail_discovery'::text, 'mail_reclassify'::text, 'maintenance'::text, 'derived_refresh'::text, 'sweep'::text]))),
    CONSTRAINT "Run_status_check" CHECK ((status = ANY (ARRAY['running'::text, 'paused'::text, 'paused_auth'::text, 'paused_offline'::text, 'needs_review'::text, 'completed'::text, 'failed'::text, 'dispatch_failed'::text]))),
    CONSTRAINT "Run_trigger_check" CHECK ((trigger = ANY (ARRAY['foreground'::text, 'discovery'::text, 'manual'::text, 'backfill'::text, 'scheduled'::text, 'ephemeral'::text])))
);

CREATE TABLE public."RunApproval" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    "operationId" text NOT NULL,
    "operationKind" text NOT NULL,
    args jsonb NOT NULL,
    "argsFingerprint" text NOT NULL,
    "targetFingerprint" text NOT NULL,
    "evidenceFingerprint" text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "decidedByUserId" text,
    "decidedAt" timestamp without time zone,
    "rejectedAt" timestamp without time zone,
    "consumedAt" timestamp without time zone,
    "invalidatedAt" timestamp without time zone,
    CONSTRAINT "RunApproval_state_check" CHECK ((state = ANY (ARRAY['pending'::text, 'granted'::text, 'rejected'::text, 'consumed'::text, 'invalidated'::text])))
);

CREATE TABLE public."RunControlEvent" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    action text NOT NULL,
    "controllerUserId" text NOT NULL,
    "controllerName" text NOT NULL,
    "controllerEmail" text NOT NULL,
    "controllerLedgerPartyId" uuid NOT NULL,
    "controllerLedgerPartyShortcode" text NOT NULL,
    "controllerLedgerPartyName" text NOT NULL,
    "controllerLedgerPartyKind" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "paidOverBudgetUsd" double precision,
    CONSTRAINT "RunControlEvent_action_check" CHECK ((action = ANY (ARRAY['prompt'::text, 'abort'::text, 'pause'::text, 'resume'::text, 'cancel'::text, 'approve'::text, 'reject'::text, 'retry'::text, 'retry_dispatch'::text, 'upload_evidence'::text, 'no_evidence_available'::text, 'escalate_sol'::text, 'run_now_paid'::text]))),
    CONSTRAINT "RunControlEvent_paid_over_budget_check" CHECK ((("paidOverBudgetUsd" IS NULL) OR ((action = 'run_now_paid'::text) AND ("paidOverBudgetUsd" > (0)::double precision))))
);

CREATE TABLE public."RunFinding" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid,
    "ledgerPartyId" uuid NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    kind text NOT NULL,
    summary text NOT NULL,
    "proposedFix" jsonb,
    "evidenceFingerprint" text NOT NULL,
    "autoApplied" boolean DEFAULT false NOT NULL,
    probability real,
    status text DEFAULT 'open'::text NOT NULL,
    "resolvedAt" timestamp without time zone,
    "expiresAt" timestamp without time zone,
    "resolvedByUserId" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "RunFinding_entityKind_check" CHECK (("entityKind" = ANY (ARRAY['purchase'::text, 'expense'::text, 'product'::text, 'run'::text, 'email'::text]))),
    CONSTRAINT "RunFinding_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'applied'::text, 'dismissed'::text])))
);

CREATE TABLE public."RunOperation" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    executor jsonb,
    "runId" uuid NOT NULL,
    "operationId" text NOT NULL,
    kind text NOT NULL,
    "inputFingerprint" text NOT NULL,
    state text DEFAULT 'started'::text NOT NULL,
    result jsonb,
    error text,
    "startedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "completedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "RunOperation_state_check" CHECK ((state = ANY (ARRAY['started'::text, 'completed'::text, 'failed'::text])))
);

CREATE TABLE public."RunPushRegistration" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    "deviceId" uuid NOT NULL,
    kind text NOT NULL,
    "pushToken" text NOT NULL,
    "apnsEnvironment" text NOT NULL,
    "appIdentity" text NOT NULL,
    "lastStateKey" text,
    "lastSentAt" timestamp without time zone,
    "lastError" text,
    "endedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "RunPushRegistration_app_identity_check" CHECK (("appIdentity" = ANY (ARRAY['production'::text, 'development'::text]))),
    CONSTRAINT "RunPushRegistration_environment_check" CHECK (("apnsEnvironment" = ANY (ARRAY['development'::text, 'production'::text]))),
    CONSTRAINT "RunPushRegistration_kind_check" CHECK ((kind = ANY (ARRAY['live_activity'::text, 'alert'::text])))
);

CREATE TABLE public."RunStep" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    "position" integer NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    found integer DEFAULT 0 NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    pages integer DEFAULT 0 NOT NULL,
    "childRunId" uuid,
    cursor jsonb,
    "pausedReason" text,
    "pausedUntil" timestamp without time zone,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    meta jsonb,
    "startedAt" timestamp without time zone,
    "endedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "RunStep_counts_check" CHECK (((found >= 0) AND (done >= 0) AND (failed >= 0) AND (skipped >= 0) AND (pages >= 0))),
    CONSTRAINT "RunStep_state_check" CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'waiting'::text, 'paused'::text, 'done'::text, 'failed'::text])))
);

CREATE TABLE public."SearchDocument" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "entityId" uuid NOT NULL,
    "entityKind" text NOT NULL,
    title text NOT NULL,
    subtitle text,
    "typeHint" text,
    aliases text[] DEFAULT ARRAY[]::text[] NOT NULL,
    keywords text[] DEFAULT ARRAY[]::text[] NOT NULL,
    body text NOT NULL,
    "semanticText" text NOT NULL,
    "normalizedText" text NOT NULL,
    "searchVector" tsvector NOT NULL,
    "sourceHash" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."SourceOrderObservation" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "sourceClaimId" uuid NOT NULL,
    "orderKey" text NOT NULL,
    "purchaseId" uuid NOT NULL,
    "vendorId" uuid NOT NULL,
    "runId" uuid,
    checksum text NOT NULL,
    extraction jsonb NOT NULL,
    "productBindings" jsonb NOT NULL,
    "primaryDocumentImageId" uuid,
    "screenshotImageId" uuid,
    "contentFingerprint" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "SourceOrderObservation_checksum_check" CHECK ((checksum ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public."SpendingCategory" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    "parentId" uuid,
    "itemizationExpectation" text DEFAULT 'unknown'::text NOT NULL,
    "productExpectation" text DEFAULT 'unknown'::text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    emoji text,
    "stockTracked" boolean,
    CONSTRAINT "SpendingCategory_itemizationExpectation_check" CHECK (("itemizationExpectation" = ANY (ARRAY['unknown'::text, 'required'::text, 'not_expected'::text]))),
    CONSTRAINT "SpendingCategory_productExpectation_check" CHECK (("productExpectation" = ANY (ARRAY['unknown'::text, 'required'::text, 'not_expected'::text, 'not_allowed'::text])))
);

CREATE TABLE public."StatementImport" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    label text NOT NULL,
    fingerprint text NOT NULL,
    "dateKind" text DEFAULT 'unknown'::text NOT NULL,
    "rowCountDeclared" integer,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    CONSTRAINT "StatementImport_dateKind_check" CHECK (("dateKind" = ANY (ARRAY['posted'::text, 'transaction'::text, 'unknown'::text]))),
    CONSTRAINT "StatementImport_rowCountDeclared_check" CHECK ((("rowCountDeclared" IS NULL) OR ("rowCountDeclared" >= 0))),
    CONSTRAINT "StatementImport_source_slug_check" CHECK (((source ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (source = lower(TRIM(BOTH FROM source)))))
);

CREATE TABLE public."StatementImportRow" (
    "importId" uuid NOT NULL,
    "statementRowId" uuid NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."StatementRow" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "batchId" uuid NOT NULL,
    source text NOT NULL,
    "externalId" text NOT NULL,
    "accountDescriptor" text NOT NULL,
    "statementDate" date NOT NULL,
    amount double precision NOT NULL,
    "providerAmount" double precision NOT NULL,
    merchant text,
    "rawDescription" text NOT NULL,
    "sourceCategory" text,
    "providerStatus" text,
    "providerNotes" text,
    "accountId" uuid,
    disposition text DEFAULT 'open'::text NOT NULL,
    "dispositionReason" text,
    "dispositionNote" text,
    "supersededByRowId" uuid,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "rowPosition" integer,
    "providerTransactionId" text,
    "legacyExternalId" text,
    CONSTRAINT "StatementRow_amount_whole_cent_check" CHECK ((abs(((amount * (100)::double precision) - round((amount * (100)::double precision)))) < (0.0000001)::double precision)),
    CONSTRAINT "StatementRow_dispositionReason_check" CHECK ((("dispositionReason" IS NULL) OR ("dispositionReason" = ANY (ARRAY['not_modeled'::text, 'not_a_purchase'::text, 'duplicate_of_other_source'::text, 'pre_cubby'::text, 'other'::text])))),
    CONSTRAINT "StatementRow_disposition_check" CHECK ((((disposition = 'open'::text) AND ("dispositionReason" IS NULL) AND ("dispositionNote" IS NULL)) OR ((disposition = 'ignored'::text) AND ("dispositionReason" IS NOT NULL) AND ("dispositionNote" IS NOT NULL)))),
    CONSTRAINT "StatementRow_externalId_format_check" CHECK (("externalId" ~ '^v[12]:[0-9a-f]{64}$'::text)),
    CONSTRAINT "StatementRow_position_check" CHECK ((("rowPosition" IS NULL) OR ("rowPosition" > 0))),
    CONSTRAINT "StatementRow_providerAmount_whole_cent_check" CHECK ((abs((("providerAmount" * (100)::double precision) - round(("providerAmount" * (100)::double precision)))) < (0.0000001)::double precision)),
    CONSTRAINT "StatementRow_providerStatus_check" CHECK ((("providerStatus" IS NULL) OR ("providerStatus" = ANY (ARRAY['posted'::text, 'pending'::text])))),
    CONSTRAINT "StatementRow_source_slug_check" CHECK (((source ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (source = lower(TRIM(BOTH FROM source)))))
);

CREATE TABLE public."Task" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'not_started'::text NOT NULL,
    "projectId" uuid,
    "projectMode" text DEFAULT 'inherit'::text NOT NULL,
    "subjectProductId" uuid,
    "subjectProductMode" text DEFAULT 'inherit'::text NOT NULL,
    "parentTaskId" uuid,
    "dueDate" date,
    "dueEndDate" date,
    trade text,
    "sortOrder" double precision,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "assigneeId" uuid,
    "assigneeMode" text DEFAULT 'inherit'::text NOT NULL
);

CREATE TABLE public."UpcLookupCache" (
    upc text NOT NULL,
    manufacturer text,
    brand text,
    "priceDollars" double precision,
    "imageUrl" text,
    status text DEFAULT 'ready'::text NOT NULL,
    "fetchedAt" timestamp without time zone NOT NULL,
    name text,
    category text,
    description text,
    source text DEFAULT 'upcitemdb'::text NOT NULL
);

CREATE TABLE public."Vendor" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    website text,
    "orderUrlTemplate" text,
    "orderEvidence" text,
    "orderEmailSenders" text[] DEFAULT '{}'::text[] NOT NULL,
    "browserDomains" text[] DEFAULT '{}'::text[] NOT NULL,
    "agentHints" jsonb DEFAULT '{"notes": [], "pagination": null, "ordersListUrl": null, "orderLinkPattern": null}'::jsonb NOT NULL,
    "returnWindowDays" integer,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "itemizationExpectation" text,
    "spendingProfile" text DEFAULT 'unspecified'::text NOT NULL,
    "defaultSpendingCategoryId" uuid,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT "Vendor_orderEvidence_check" CHECK ((("orderEvidence" IS NULL) OR ("orderEvidence" = ANY (ARRAY['online_account'::text, 'receipt_only'::text, 'not_expected'::text])))),
    CONSTRAINT "Vendor_returnWindowDays_check" CHECK ((("returnWindowDays" IS NULL) OR ("returnWindowDays" >= 0))),
    CONSTRAINT "Vendor_spendingProfile_check" CHECK (("spendingProfile" = ANY (ARRAY['unspecified'::text, 'mixed_retail'::text, 'food_retail'::text, 'restaurant'::text, 'coffee_shop'::text])))
);

CREATE TABLE public."VendorAccount" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    "vendorId" uuid NOT NULL,
    "ledgerPartyId" uuid NOT NULL,
    "inventoryOwnerDefaultEnabled" boolean DEFAULT false NOT NULL,
    cursor jsonb DEFAULT '{"newestOrderAt": null, "orderIdsOnNewestDate": [], "backfillBeforeOrderAt": null, "earliestAvailableOrderAt": null}'::jsonb NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public."Wish" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    name text NOT NULL,
    notes text,
    "acquiredAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE TABLE public.account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp without time zone,
    refresh_token_expires_at timestamp without time zone,
    scope text,
    password text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE TABLE public.apikey (
    id text NOT NULL,
    name text,
    start text,
    prefix text,
    key text NOT NULL,
    reference_id text NOT NULL,
    config_id text DEFAULT 'default'::text NOT NULL,
    refill_interval integer,
    refill_amount integer,
    last_refill_at timestamp without time zone,
    enabled boolean DEFAULT true,
    rate_limit_enabled boolean DEFAULT true,
    rate_limit_time_window integer DEFAULT 86400000,
    rate_limit_max integer DEFAULT 10,
    request_count integer DEFAULT 0,
    remaining integer,
    last_request timestamp without time zone,
    expires_at timestamp without time zone,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    permissions text,
    metadata text
);

CREATE TABLE public.jwks (
    id text NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    expires_at timestamp without time zone,
    alg text,
    crv text
);

CREATE TABLE public.oauth_access_token (
    id text NOT NULL,
    token text,
    client_id text NOT NULL,
    session_id text,
    user_id text,
    reference_id text,
    authorization_code_id text,
    resources text[],
    requested_user_info_claims text[],
    refresh_id text,
    expires_at timestamp without time zone,
    created_at timestamp without time zone,
    revoked timestamp without time zone,
    confirmation jsonb,
    scopes text[] NOT NULL
);

CREATE TABLE public.oauth_client (
    id text NOT NULL,
    client_id text NOT NULL,
    client_secret text,
    client_discovery_id text,
    disabled boolean DEFAULT false,
    skip_consent boolean,
    enable_end_session boolean,
    subject_type text,
    scopes text[],
    client_credentials_scopes text[] DEFAULT '{}'::text[],
    user_id text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    name text,
    uri text,
    icon text,
    contacts text[],
    tos text,
    policy text,
    software_id text,
    software_version text,
    software_statement text,
    redirect_uris text[] NOT NULL,
    post_logout_redirect_uris text[],
    backchannel_logout_uri text,
    backchannel_logout_session_required boolean,
    token_endpoint_auth_method text,
    grant_types text[],
    response_types text[],
    application_type text,
    jwks text,
    jwks_uri text,
    dpop_bound_access_tokens boolean DEFAULT false,
    require_pkce boolean,
    reference_id text,
    metadata jsonb
);

CREATE TABLE public.oauth_client_assertion (
    id text NOT NULL,
    expires_at timestamp without time zone NOT NULL
);

CREATE TABLE public.oauth_client_resource (
    id text NOT NULL,
    client_id text NOT NULL,
    resource_id text NOT NULL,
    metadata jsonb,
    created_at timestamp without time zone
);

CREATE TABLE public.oauth_consent (
    id text NOT NULL,
    client_id text NOT NULL,
    user_id text,
    reference_id text,
    resources text[],
    requested_user_info_claims text[],
    scopes text[] NOT NULL,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);

CREATE TABLE public.oauth_refresh_token (
    id text NOT NULL,
    token text NOT NULL,
    client_id text NOT NULL,
    session_id text,
    user_id text NOT NULL,
    reference_id text,
    authorization_code_id text,
    resources text[],
    requested_user_info_claims text[],
    expires_at timestamp without time zone,
    created_at timestamp without time zone,
    revoked timestamp without time zone,
    rotated_at timestamp without time zone,
    rotation_replay_response text,
    rotation_replay_expires_at timestamp without time zone,
    auth_time timestamp without time zone,
    confirmation jsonb,
    scopes text[] NOT NULL
);

CREATE TABLE public.oauth_resource (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    access_token_ttl integer,
    refresh_token_ttl integer,
    signing_algorithm text,
    signing_key_id text,
    allowed_scopes text[],
    custom_claims jsonb,
    dpop_bound_access_tokens_required boolean DEFAULT false,
    disabled boolean DEFAULT false,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    policy_version integer DEFAULT 1,
    metadata jsonb
);

CREATE TABLE public.passkey (
    id text NOT NULL,
    name text,
    public_key text NOT NULL,
    user_id text NOT NULL,
    credential_id text NOT NULL,
    counter integer NOT NULL,
    device_type text NOT NULL,
    backed_up boolean NOT NULL,
    transports text,
    created_at timestamp without time zone DEFAULT now(),
    aaguid text
);

CREATE TABLE public.session (
    id text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public."AiAnalysis"
    ADD CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AiEvaluationRequest"
    ADD CONSTRAINT "AiEvaluationRequest_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AiEvaluation"
    ADD CONSTRAINT "AiEvaluation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AiUsage"
    ADD CONSTRAINT "AiUsage_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AppSettings"
    ADD CONSTRAINT "AppSettings_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AssessmentState"
    ADD CONSTRAINT "AssessmentState_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Assessment"
    ADD CONSTRAINT "Assessment_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AutomaticRule"
    ADD CONSTRAINT "AutomaticRule_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Cookbook"
    ADD CONSTRAINT "Cookbook_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DataException"
    ADD CONSTRAINT "DataException_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DerivedDiscoveryPass"
    ADD CONSTRAINT "DerivedDiscoveryPass_pkey" PRIMARY KEY (family);

ALTER TABLE ONLY public."DerivedRefreshCaptureInbox"
    ADD CONSTRAINT "DerivedRefreshCaptureInbox_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DerivedRefreshCursor"
    ADD CONSTRAINT "DerivedRefreshCursor_pkey" PRIMARY KEY (key);

ALTER TABLE ONLY public."DerivedRefreshObservedInput"
    ADD CONSTRAINT "DerivedRefreshObservedInput_pkey" PRIMARY KEY (key);

ALTER TABLE ONLY public."DerivedRefreshRevision"
    ADD CONSTRAINT "DerivedRefreshRevision_pkey" PRIMARY KEY (key);

ALTER TABLE ONLY public."DerivedRefreshScope"
    ADD CONSTRAINT "DerivedRefreshScope_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DerivedRefreshWork"
    ADD CONSTRAINT "DerivedRefreshWork_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Device"
    ADD CONSTRAINT "Device_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EmailAccuracyEvaluation"
    ADD CONSTRAINT "EmailAccuracyEvaluation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EmailCandidateObservation"
    ADD CONSTRAINT "EmailCandidateObservation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EmailClassificationObservation"
    ADD CONSTRAINT "EmailClassificationObservation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EmailFinancialAssociation"
    ADD CONSTRAINT "EmailFinancialAssociation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EmailRetrievalFailure"
    ADD CONSTRAINT "EmailRetrievalFailure_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Email"
    ADD CONSTRAINT "Email_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EntityAttachment"
    ADD CONSTRAINT "EntityAttachment_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EntityEmbedding"
    ADD CONSTRAINT "EntityEmbedding_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EntityExternalId"
    ADD CONSTRAINT "EntityExternalId_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EntityLink"
    ADD CONSTRAINT "EntityLink_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Entity"
    ADD CONSTRAINT "Entity_id_kind_key" UNIQUE (id, kind);

ALTER TABLE ONLY public."Entity"
    ADD CONSTRAINT "Entity_id_shortcode_key" UNIQUE (id, shortcode);

ALTER TABLE ONLY public."Entity"
    ADD CONSTRAINT "Entity_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ExpenseAttribution"
    ADD CONSTRAINT "ExpenseAttribution_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Expense"
    ADD CONSTRAINT "Expense_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ExternalSource"
    ADD CONSTRAINT "ExternalSource_pkey" PRIMARY KEY (slug);

ALTER TABLE ONLY public."Feedback"
    ADD CONSTRAINT "Feedback_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."FinancialAccount"
    ADD CONSTRAINT "FinancialAccount_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."FinancialTransactionAllocation"
    ADD CONSTRAINT "FinancialTransactionAllocation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."FinancialTransaction"
    ADD CONSTRAINT "FinancialTransaction_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."GardenEntry"
    ADD CONSTRAINT "GardenEntry_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImageDerivative"
    ADD CONSTRAINT "ImageDerivative_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImageProcessingAttempt"
    ADD CONSTRAINT "ImageProcessingAttempt_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImageProcessingEvent"
    ADD CONSTRAINT "ImageProcessingEvent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImageProcessingJob"
    ADD CONSTRAINT "ImageProcessingJob_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImageProcessingOrphan"
    ADD CONSTRAINT "ImageProcessingOrphan_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImageProcessingSubmissionJob"
    ADD CONSTRAINT "ImageProcessingSubmissionJob_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImageProcessingSubmission"
    ADD CONSTRAINT "ImageProcessingSubmission_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImageSighting"
    ADD CONSTRAINT "ImageSighting_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Image"
    ADD CONSTRAINT "Image_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImportPreparedLine"
    ADD CONSTRAINT "ImportPreparedLine_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImportPreparedOrder"
    ADD CONSTRAINT "ImportPreparedOrder_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImportSourceClaim"
    ADD CONSTRAINT "ImportSourceClaim_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImportSourceOrder"
    ADD CONSTRAINT "ImportSourceOrder_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ImportSourceProduct"
    ADD CONSTRAINT "ImportSourceProduct_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Ingredient"
    ADD CONSTRAINT "Ingredient_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."InventoryEntry"
    ADD CONSTRAINT "InventoryEntry_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."LedgerParty"
    ADD CONSTRAINT "LedgerParty_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."LedgerSourceClaim"
    ADD CONSTRAINT "LedgerSourceClaim_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."LedgerTransfer"
    ADD CONSTRAINT "LedgerTransfer_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Location"
    ADD CONSTRAINT "Location_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MailboxCursor"
    ADD CONSTRAINT "MailboxCursor_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."McpToolCall"
    ADD CONSTRAINT "McpToolCall_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MealFoodEntry"
    ADD CONSTRAINT "MealFoodEntry_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MealRecipePortion"
    ADD CONSTRAINT "MealRecipePortion_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MealRecipe"
    ADD CONSTRAINT "MealRecipe_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Meal"
    ADD CONSTRAINT "Meal_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MerchantVendorRule"
    ADD CONSTRAINT "MerchantVendorRule_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OrderMailAttachment"
    ADD CONSTRAINT "OrderMailAttachment_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OrderMailEvent"
    ADD CONSTRAINT "OrderMailEvent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OrderMail"
    ADD CONSTRAINT "OrderMail_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."PhotoGroupProposal"
    ADD CONSTRAINT "PhotoGroupProposal_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."PhotoRunImage"
    ADD CONSTRAINT "PhotoRunImage_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Plant"
    ADD CONSTRAINT "Plant_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Planting"
    ADD CONSTRAINT "Planting_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ProductCategory"
    ADD CONSTRAINT "ProductCategory_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ProductConversionCoverage"
    ADD CONSTRAINT "ProductConversionCoverage_pkey" PRIMARY KEY ("productId");

ALTER TABLE ONLY public."ProductUnitMapping"
    ADD CONSTRAINT "ProductUnitMapping_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Project"
    ADD CONSTRAINT "Project_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."PurchasePaymentEvidence"
    ADD CONSTRAINT "PurchasePaymentEvidence_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."RecipeSectionIngredient"
    ADD CONSTRAINT "RecipeSectionIngredient_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."RecipeSection"
    ADD CONSTRAINT "RecipeSection_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Recipe"
    ADD CONSTRAINT "Recipe_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."RunApproval"
    ADD CONSTRAINT "RunApproval_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."RunControlEvent"
    ADD CONSTRAINT "RunControlEvent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."RunFinding"
    ADD CONSTRAINT "RunFinding_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."RunOperation"
    ADD CONSTRAINT "RunOperation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."RunPushRegistration"
    ADD CONSTRAINT "RunPushRegistration_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."RunStep"
    ADD CONSTRAINT "RunStep_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Run"
    ADD CONSTRAINT "Run_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."SearchDocument"
    ADD CONSTRAINT "SearchDocument_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."SourceOrderObservation"
    ADD CONSTRAINT "SourceOrderObservation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."SpendingCategory"
    ADD CONSTRAINT "SpendingCategory_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."StatementImport"
    ADD CONSTRAINT "StatementImport_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."StatementRow"
    ADD CONSTRAINT "StatementRow_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."UpcLookupCache"
    ADD CONSTRAINT "UpcLookupCache_pkey" PRIMARY KEY (upc);

ALTER TABLE ONLY public."VendorAccount"
    ADD CONSTRAINT "VendorAccount_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Vendor"
    ADD CONSTRAINT "Vendor_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Wish"
    ADD CONSTRAINT "Wish_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.apikey
    ADD CONSTRAINT apikey_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_token_unique UNIQUE (token);

ALTER TABLE ONLY public.oauth_client_assertion
    ADD CONSTRAINT oauth_client_assertion_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_client
    ADD CONSTRAINT oauth_client_client_id_unique UNIQUE (client_id);

ALTER TABLE ONLY public.oauth_client
    ADD CONSTRAINT oauth_client_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_client_resource
    ADD CONSTRAINT oauth_client_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_token_unique UNIQUE (token);

ALTER TABLE ONLY public.oauth_resource
    ADD CONSTRAINT oauth_resource_identifier_unique UNIQUE (identifier);

ALTER TABLE ONLY public.oauth_resource
    ADD CONSTRAINT oauth_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT passkey_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_unique UNIQUE (token);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_unique UNIQUE (email);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX "AiAnalysis_active_key" ON public."AiAnalysis" USING btree ("entityKind", "entityId", feature, model, "promptVersion", "inputFingerprint", COALESCE(provider, ''::text), COALESCE("resultSchemaRevision", 0)) WHERE ("deletedAt" IS NULL);

CREATE INDEX "AiAnalysis_entity_idx" ON public."AiAnalysis" USING btree ("entityKind", "entityId");

CREATE INDEX "AiAnalysis_feature_idx" ON public."AiAnalysis" USING btree (feature);

CREATE INDEX "AiEvaluationRequest_evaluation_idx" ON public."AiEvaluationRequest" USING btree ("evaluationId");

CREATE UNIQUE INDEX "AiEvaluationRequest_run_item_key" ON public."AiEvaluationRequest" USING btree ("runId", "evaluationId");

CREATE INDEX "AiEvaluation_admission_idx" ON public."AiEvaluation" USING btree ("executionKind", state, "deadlineAt");

CREATE INDEX "AiEvaluation_feature_idx" ON public."AiEvaluation" USING btree (feature);

CREATE UNIQUE INDEX "AiEvaluation_pending_share_key" ON public."AiEvaluation" USING btree ("shareKey") WHERE (("shareKey" IS NOT NULL) AND (state = ANY (ARRAY['queued'::text, 'running'::text, 'result_ready'::text, 'retry_wait'::text])));

CREATE INDEX "AiEvaluation_run_state_idx" ON public."AiEvaluation" USING btree ("runId", state, "nextAttemptAt");

CREATE UNIQUE INDEX "AiEvaluation_work_key" ON public."AiEvaluation" USING btree ("workKey");

CREATE INDEX "AiUsage_createdAt_idx" ON public."AiUsage" USING btree ("createdAt");

CREATE INDEX "AiUsage_entity_idx" ON public."AiUsage" USING btree ("entityKind", "entityId");

CREATE INDEX "AiUsage_feature_createdAt_idx" ON public."AiUsage" USING btree (feature, "createdAt" DESC NULLS LAST);

CREATE INDEX "AiUsage_job_idx" ON public."AiUsage" USING btree ("jobKind", "jobId");

CREATE INDEX "AiUsage_model_createdAt_idx" ON public."AiUsage" USING btree (model, "createdAt" DESC NULLS LAST);

CREATE INDEX "AiUsage_run_idx" ON public."AiUsage" USING btree ("runId");

CREATE UNIQUE INDEX "AssessmentState_email_event_purchase_key" ON public."AssessmentState" USING btree (((data ->> 'eventId'::text)), ((data ->> 'purchaseId'::text))) WHERE ((family = 'email_link'::text) AND active);

CREATE INDEX "AssessmentState_email_linked_event_uuid_idx" ON public."AssessmentState" USING btree ((((data ->> 'eventId'::text))::uuid)) WHERE ((family = 'email_link'::text) AND active AND ((data ->> 'decision'::text) = 'linked'::text));

CREATE UNIQUE INDEX "AssessmentState_email_one_link_key" ON public."AssessmentState" USING btree (((data ->> 'eventId'::text))) WHERE ((family = 'email_link'::text) AND active AND ((data ->> 'decision'::text) = 'linked'::text));

CREATE INDEX "AssessmentState_email_purchase_uuid_idx" ON public."AssessmentState" USING btree ((((data ->> 'purchaseId'::text))::uuid)) WHERE ((family = 'email_link'::text) AND active);

CREATE INDEX "AssessmentState_entity_field_status_idx" ON public."AssessmentState" USING btree (entity, field, status);

CREATE INDEX "AssessmentState_entity_record_status_idx" ON public."AssessmentState" USING btree (entity, "recordId", status);

CREATE INDEX "AssessmentState_evaluation_idx" ON public."AssessmentState" USING btree ("evaluationId");

CREATE INDEX "AssessmentState_family_active_idx" ON public."AssessmentState" USING btree (family, active, status);

CREATE INDEX "AssessmentState_run_status_idx" ON public."AssessmentState" USING btree ("runId", status);

CREATE INDEX "AssessmentState_statement_account_idx" ON public."AssessmentState" USING btree (((data ->> 'accountId'::text)), ((data ->> 'month'::text))) WHERE ((family = 'statement_transaction'::text) AND active AND (status = 'pending'::text));

CREATE INDEX "AssessmentState_statement_charge_history_idx" ON public."AssessmentState" USING btree (((data ->> 'source'::text)), ((data ->> 'chargeKey'::text)), "createdAt" DESC, id DESC) WHERE (family = 'statement_transaction'::text);

CREATE UNIQUE INDEX "AssessmentState_statement_charge_key" ON public."AssessmentState" USING btree (((data ->> 'source'::text)), ((data ->> 'chargeKey'::text))) WHERE ((family = 'statement_transaction'::text) AND active);

CREATE INDEX "AssessmentState_statement_refs_idx" ON public."AssessmentState" USING gin (((data -> 'refs'::text))) WHERE ((family = 'statement_transaction'::text) AND active AND (status = 'pending'::text));

CREATE INDEX "Assessment_family_idx" ON public."Assessment" USING btree (family, "createdAt");

CREATE UNIQUE INDEX "Assessment_publication_key" ON public."Assessment" USING btree ("publicationKey");

CREATE INDEX "AuditLog_createdAt_id_idx" ON public."AuditLog" USING btree ("createdAt" DESC, id DESC);

CREATE INDEX "AuditLog_entityKind_entityId_createdAt_idx" ON public."AuditLog" USING btree ("entityKind", "entityId", "createdAt" DESC NULLS LAST);

CREATE INDEX "AuditLog_runId_entityKind_idx" ON public."AuditLog" USING btree ("runId", "entityKind") WHERE ("runId" IS NOT NULL);

CREATE UNIQUE INDEX "AutomaticRule_family_key" ON public."AutomaticRule" USING btree (family, "ruleKey");

CREATE INDEX "Cookbook_createdAt_idx" ON public."Cookbook" USING btree ("createdAt");

CREATE INDEX "Cookbook_name_gin_idx" ON public."Cookbook" USING gin (name public.gin_trgm_ops);

CREATE UNIQUE INDEX "Cookbook_name_key" ON public."Cookbook" USING btree (name) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Cookbook_productId_idx" ON public."Cookbook" USING btree ("productId");

CREATE UNIQUE INDEX "Cookbook_shortcode_unique" ON public."Cookbook" USING btree (shortcode);

CREATE UNIQUE INDEX "DataException_entity_check_key" ON public."DataException" USING btree ("entityId", "check");

CREATE INDEX "DerivedRefreshCaptureInbox_kind_idx" ON public."DerivedRefreshCaptureInbox" USING btree ("entityKind");

CREATE INDEX "DerivedRefreshCaptureInbox_order_idx" ON public."DerivedRefreshCaptureInbox" USING btree ("createdAt", id);

CREATE UNIQUE INDEX "DerivedRefreshFailure_input_key" ON public."DerivedRefreshFailure" USING btree ("entityKind", "entityId", phase, fingerprint);

CREATE UNIQUE INDEX "DerivedRefreshPublication_entity_phase_key" ON public."DerivedRefreshPublication" USING btree ("entityKind", "entityId", phase);

CREATE INDEX "DerivedRefreshScope_pending_idx" ON public."DerivedRefreshScope" USING btree ("workId", done, id);

CREATE UNIQUE INDEX "DerivedRefreshScope_wave_entity_key" ON public."DerivedRefreshScope" USING btree ("workId", "entityKind", "entityId");

CREATE UNIQUE INDEX "DerivedRefreshSnapshot_entity_key" ON public."DerivedRefreshSnapshot" USING btree ("entityKind", "entityId");

CREATE INDEX "DerivedRefreshWork_due_idx" ON public."DerivedRefreshWork" USING btree (state, "availableAt", id);

CREATE INDEX "DerivedRefreshWork_entity_idx" ON public."DerivedRefreshWork" USING btree ("entityKind", "entityId");

CREATE UNIQUE INDEX "DerivedRefreshWork_root_key" ON public."DerivedRefreshWork" USING btree ("entityKind", "entityId");

CREATE UNIQUE INDEX "Device_installationId_key" ON public."Device" USING btree ("installationId") WHERE ("deletedAt" IS NULL);

CREATE INDEX "Device_ledgerPartyId_idx" ON public."Device" USING btree ("ledgerPartyId");

CREATE INDEX "Device_productId_idx" ON public."Device" USING btree ("productId");

CREATE UNIQUE INDEX "Device_shortcode_unique" ON public."Device" USING btree (shortcode);

CREATE INDEX "EmailAccuracyEvaluation_owner_idx" ON public."EmailAccuracyEvaluation" USING btree ("ownerUserId", "createdAt" DESC NULLS LAST);

CREATE INDEX "EmailCandidateObservation_email_idx" ON public."EmailCandidateObservation" USING btree ("emailId");

CREATE INDEX "EmailClassificationObservation_email_idx" ON public."EmailClassificationObservation" USING btree ("emailId");

CREATE INDEX "EmailClassificationObservation_evaluation_idx" ON public."EmailClassificationObservation" USING btree ("evaluationId");

CREATE UNIQUE INDEX "EmailFinancialAssociation_email_evidence_transaction_key" ON public."EmailFinancialAssociation" USING btree ("emailId", "evidenceChecksum", "transactionId");

CREATE INDEX "EmailFinancialAssociation_transaction_idx" ON public."EmailFinancialAssociation" USING btree ("transactionId");

CREATE INDEX "EmailRetrievalFailure_email_idx" ON public."EmailRetrievalFailure" USING btree ("emailId");

CREATE INDEX "Email_ledgerPartyId_receivedAt_idx" ON public."Email" USING btree ("ledgerPartyId", "receivedAt" DESC NULLS LAST);

CREATE UNIQUE INDEX "Email_mailbox_message_key" ON public."Email" USING btree ("ledgerPartyId", provider, "mailboxId", "messageId");

CREATE INDEX "Email_orderMailId_idx" ON public."Email" USING btree ("orderMailId");

CREATE UNIQUE INDEX "Email_orderMailId_key" ON public."Email" USING btree ("orderMailId") WHERE ("orderMailId" IS NOT NULL);

CREATE INDEX "Email_pending_idx" ON public."Email" USING btree ("ledgerPartyId", "mailboxId", status);

CREATE INDEX "Email_runId_idx" ON public."Email" USING btree ("runId");

CREATE UNIQUE INDEX "Email_shortcode_unique" ON public."Email" USING btree (shortcode);

CREATE INDEX "Email_source_key_idx" ON public."Email" USING btree ("ledgerPartyId", (((((provider || ':'::text) || "mailboxId") || ':'::text) || "messageId")));

CREATE UNIQUE INDEX "EntityAttachment_entity_idempotency_key" ON public."EntityAttachment" USING btree ("entityId", "idempotencyKey") WHERE (("idempotencyKey" IS NOT NULL) AND ("deletedAt" IS NULL));

CREATE UNIQUE INDEX "EntityAttachment_entity_image_key" ON public."EntityAttachment" USING btree ("entityId", "imageId") WHERE ("deletedAt" IS NULL);

CREATE INDEX "EntityAttachment_entity_order_idx" ON public."EntityAttachment" USING btree ("entityId", "sortOrder");

CREATE UNIQUE INDEX "EntityAttachment_entity_singular_role_key" ON public."EntityAttachment" USING btree ("entityId", role) WHERE ((role = ANY (ARRAY['cover'::text, 'logo'::text])) AND ("deletedAt" IS NULL));

CREATE INDEX "EntityAttachment_imageId_idx" ON public."EntityAttachment" USING btree ("imageId");

CREATE INDEX "EntityEmbedding_entity_idx" ON public."EntityEmbedding" USING btree ("entityKind", "entityId");

CREATE UNIQUE INDEX "EntityEmbedding_entity_model_key" ON public."EntityEmbedding" USING btree ("entityKind", "entityId", provider, model, dimensions) WHERE ("deletedAt" IS NULL);

CREATE INDEX "EntityEmbedding_model_idx" ON public."EntityEmbedding" USING btree (provider, model, dimensions);

CREATE UNIQUE INDEX "EntityEmbedding_one_submission_key" ON public."EntityEmbedding" USING btree ("entityKind", "entityId", provider, model, dimensions) WHERE ("artifactState" = ANY (ARRAY['prepared'::text, 'submitting'::text, 'submitted'::text]));

CREATE INDEX "EntityEmbedding_recovery_idx" ON public."EntityEmbedding" USING btree ("availableAt", id);

CREATE INDEX "EntityExternalId_entityId_idx" ON public."EntityExternalId" USING btree ("entityId");

CREATE UNIQUE INDEX "EntityExternalId_entity_source_kind_primary_key" ON public."EntityExternalId" USING btree ("entityId", source, kind) WHERE ("isPrimary" AND ("deletedAt" IS NULL));

CREATE UNIQUE INDEX "EntityExternalId_source_kind_externalId_key" ON public."EntityExternalId" USING btree (source, kind, "externalId") WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "EntityLink_kind_from_to_key" ON public."EntityLink" USING btree (kind, "fromEntityId", "toEntityId") WHERE ("deletedAt" IS NULL);

CREATE INDEX "EntityLink_to_kind_idx" ON public."EntityLink" USING btree ("toEntityId", kind) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Entity_mergedIntoId_idx" ON public."Entity" USING btree ("mergedIntoId");

CREATE UNIQUE INDEX "Entity_shortcode_unique" ON public."Entity" USING btree (shortcode);

CREATE INDEX "ExpenseAttribution_expenseId_idx" ON public."ExpenseAttribution" USING btree ("expenseId");

CREATE UNIQUE INDEX "ExpenseAttribution_expenseId_role_ledgerPartyId_key" ON public."ExpenseAttribution" USING btree ("expenseId", role, "ledgerPartyId") WHERE (("deletedAt" IS NULL) AND ("ledgerPartyId" IS NOT NULL));

CREATE UNIQUE INDEX "ExpenseAttribution_expenseId_role_unattributed_key" ON public."ExpenseAttribution" USING btree ("expenseId", role) WHERE (("deletedAt" IS NULL) AND ("ledgerPartyId" IS NULL));

CREATE INDEX "ExpenseAttribution_ledgerPartyId_idx" ON public."ExpenseAttribution" USING btree ("ledgerPartyId");

CREATE INDEX "Expense_bookingTransactionCode_idx" ON public."Expense" USING btree ("bookingTransactionCode");

CREATE INDEX "Expense_costType_idx" ON public."Expense" USING btree ("costType");

CREATE INDEX "Expense_date_idx" ON public."Expense" USING btree (date);

CREATE INDEX "Expense_lineKind_idx" ON public."Expense" USING btree ("lineKind");

CREATE INDEX "Expense_name_gin_idx" ON public."Expense" USING gin (name public.gin_trgm_ops);

CREATE INDEX "Expense_productId_idx" ON public."Expense" USING btree ("productId");

CREATE INDEX "Expense_projectId_idx" ON public."Expense" USING btree ("projectId");

CREATE INDEX "Expense_purchaseId_idx" ON public."Expense" USING btree ("purchaseId");

CREATE UNIQUE INDEX "Expense_shortcode_unique" ON public."Expense" USING btree (shortcode);

CREATE INDEX "Expense_spendingCategoryId_idx" ON public."Expense" USING btree ("spendingCategoryId");

CREATE UNIQUE INDEX "ExternalSource_vendor_issuer_key" ON public."ExternalSource" USING btree ("vendorId") WHERE issuer;

CREATE INDEX "Feedback_assessment_idx" ON public."Feedback" USING btree ("assessmentId", "createdAt");

CREATE UNIQUE INDEX "Feedback_operation_key" ON public."Feedback" USING btree ("assessmentId", "operationId");

CREATE INDEX "FinancialAccount_ledgerPartyId_idx" ON public."FinancialAccount" USING btree ("ledgerPartyId");

CREATE INDEX "FinancialAccount_name_idx" ON public."FinancialAccount" USING btree (name);

CREATE INDEX "FinancialAccount_primaryCardholderId_idx" ON public."FinancialAccount" USING btree ("primaryCardholderId");

CREATE UNIQUE INDEX "FinancialAccount_provider_owner_key" ON public."FinancialAccount" USING btree ("providerVendorId", "ledgerPartyId") WHERE (("providerVendorId" IS NOT NULL) AND ("deletedAt" IS NULL));

CREATE INDEX "FinancialAccount_provisional_idx" ON public."FinancialAccount" USING btree (provisional);

CREATE UNIQUE INDEX "FinancialAccount_shortcode_unique" ON public."FinancialAccount" USING btree (shortcode);

CREATE INDEX "FinancialTransactionAllocation_purchaseId_idx" ON public."FinancialTransactionAllocation" USING btree ("purchaseId");

CREATE INDEX "FinancialTransactionAllocation_transactionId_idx" ON public."FinancialTransactionAllocation" USING btree ("transactionId");

CREATE UNIQUE INDEX "FinancialTransactionAllocation_transactionId_purchaseId_key" ON public."FinancialTransactionAllocation" USING btree ("transactionId", "purchaseId") WHERE ("deletedAt" IS NULL);

CREATE INDEX "FinancialTransaction_accountId_idx" ON public."FinancialTransaction" USING btree ("accountId");

CREATE INDEX "FinancialTransaction_kind_idx" ON public."FinancialTransaction" USING btree (kind);

CREATE INDEX "FinancialTransaction_ledgerTransferId_idx" ON public."FinancialTransaction" USING btree ("ledgerTransferId");

CREATE UNIQUE INDEX "FinancialTransaction_ledgerTransferId_negative_evidence_key" ON public."FinancialTransaction" USING btree ("ledgerTransferId") WHERE (("deletedAt" IS NULL) AND ("ledgerTransferId" IS NOT NULL) AND (amount < (0)::double precision));

CREATE UNIQUE INDEX "FinancialTransaction_ledgerTransferId_positive_evidence_key" ON public."FinancialTransaction" USING btree ("ledgerTransferId") WHERE (("deletedAt" IS NULL) AND ("ledgerTransferId" IS NOT NULL) AND (amount > (0)::double precision));

CREATE INDEX "FinancialTransaction_postedDate_idx" ON public."FinancialTransaction" USING btree ("postedDate");

CREATE UNIQUE INDEX "FinancialTransaction_shortcode_unique" ON public."FinancialTransaction" USING btree (shortcode);

CREATE INDEX "FinancialTransaction_spendingCategoryId_idx" ON public."FinancialTransaction" USING btree ("spendingCategoryId");

CREATE INDEX "FinancialTransaction_status_idx" ON public."FinancialTransaction" USING btree (status);

CREATE INDEX "FinancialTransaction_transactionDate_idx" ON public."FinancialTransaction" USING btree ("transactionDate");

CREATE INDEX "GardenEntry_locationId_idx" ON public."GardenEntry" USING btree ("locationId");

CREATE INDEX "GardenEntry_observedOn_idx" ON public."GardenEntry" USING btree ("observedOn");

CREATE UNIQUE INDEX "GardenEntry_shortcode_unique" ON public."GardenEntry" USING btree (shortcode);

CREATE INDEX "ImageDerivative_image_idx" ON public."ImageDerivative" USING btree ("imageId");

CREATE UNIQUE INDEX "ImageDerivative_image_purpose_source_revision_key" ON public."ImageDerivative" USING btree ("imageId", purpose, "sourceContentHash", "processorRevision") WHERE ("deletedAt" IS NULL);

CREATE INDEX "ImageDerivative_status_idx" ON public."ImageDerivative" USING btree (status);

CREATE UNIQUE INDEX "ImageDerivative_storage_key_key" ON public."ImageDerivative" USING btree (key) WHERE ("deletedAt" IS NULL);

CREATE INDEX "ImageProcessingAttempt_device_idx" ON public."ImageProcessingAttempt" USING btree (((executor ->> 'deviceId'::text)));

CREATE UNIQUE INDEX "ImageProcessingAttempt_job_number_key" ON public."ImageProcessingAttempt" USING btree ("jobId", number);

CREATE INDEX "ImageProcessingAttempt_submission_idx" ON public."ImageProcessingAttempt" USING btree ("submissionId");

CREATE UNIQUE INDEX "ImageProcessingEvent_job_event_key" ON public."ImageProcessingEvent" USING btree ("jobId", "eventKey");

CREATE INDEX "ImageProcessingEvent_job_time_idx" ON public."ImageProcessingEvent" USING btree ("jobId", "occurredAt", id);

CREATE INDEX "ImageProcessingJob_derivativeId_idx" ON public."ImageProcessingJob" USING btree ("derivativeId");

CREATE INDEX "ImageProcessingJob_dispatch_idx" ON public."ImageProcessingJob" USING btree (state, "nextAttemptAt");

CREATE UNIQUE INDEX "ImageProcessingJob_identity_key" ON public."ImageProcessingJob" USING btree ("imageId", kind, "sourceContentHash", "processorRevision");

CREATE INDEX "ImageProcessingJob_imageId_createdAt_idx" ON public."ImageProcessingJob" USING btree ("imageId", "createdAt" DESC NULLS LAST);

CREATE INDEX "ImageProcessingJob_runId_idx" ON public."ImageProcessingJob" USING btree ("runId");

CREATE UNIQUE INDEX "ImageProcessingJob_shortcode_unique" ON public."ImageProcessingJob" USING btree (shortcode);

CREATE INDEX "ImageProcessingJob_submissionId_idx" ON public."ImageProcessingJob" USING btree ("submissionId");

CREATE INDEX "ImageProcessingOrphan_createdAt_idx" ON public."ImageProcessingOrphan" USING btree ("createdAt");

CREATE UNIQUE INDEX "ImageProcessingOrphan_key_key" ON public."ImageProcessingOrphan" USING btree (key);

CREATE UNIQUE INDEX "ImageProcessingSubmissionJob_membership_key" ON public."ImageProcessingSubmissionJob" USING btree ("submissionId", "jobId");

CREATE UNIQUE INDEX "ImageProcessingSubmission_publicId_key" ON public."ImageProcessingSubmission" USING btree ("publicId");

CREATE INDEX "ImageSighting_deviceId_idx" ON public."ImageSighting" USING btree ("deviceId");

CREATE INDEX "ImageSighting_imageId_idx" ON public."ImageSighting" USING btree ("imageId");

CREATE UNIQUE INDEX "ImageSighting_image_party_asset_key" ON public."ImageSighting" USING btree ("imageId", "ledgerPartyId", "assetKey") WHERE ("deletedAt" IS NULL);

CREATE INDEX "ImageSighting_ledgerPartyId_idx" ON public."ImageSighting" USING btree ("ledgerPartyId");

CREATE INDEX "Image_capturedByPartyId_idx" ON public."Image" USING btree ("capturedByPartyId");

CREATE INDEX "Image_createdAt_idx" ON public."Image" USING btree ("createdAt");

CREATE UNIQUE INDEX "Image_key_key" ON public."Image" USING btree (key) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "Image_shortcode_unique" ON public."Image" USING btree (shortcode);

CREATE INDEX "Image_status_idx" ON public."Image" USING btree (status);

CREATE UNIQUE INDEX "ImportPreparedLine_order_position_key" ON public."ImportPreparedLine" USING btree ("preparedOrderId", "position");

CREATE UNIQUE INDEX "ImportPreparedLine_order_stable_line_key" ON public."ImportPreparedLine" USING btree ("preparedOrderId", "stableLineId");

CREATE INDEX "ImportPreparedOrder_prepare_operation_idx" ON public."ImportPreparedOrder" USING btree ("runId", "prepareOperationId");

CREATE UNIQUE INDEX "ImportPreparedOrder_run_item_operation_key" ON public."ImportPreparedOrder" USING btree ("runId", "itemOperationId");

CREATE UNIQUE INDEX "ImportPreparedOrder_run_stable_order_key" ON public."ImportPreparedOrder" USING btree ("runId", "stableOrderId");

CREATE INDEX "ImportSourceClaim_canonical_idx" ON public."ImportSourceClaim" USING btree ("canonicalClaimId");

CREATE UNIQUE INDEX "ImportSourceClaim_source_key" ON public."ImportSourceClaim" USING btree ("ledgerPartyId", kind, "externalKey");

CREATE INDEX "ImportSourceOrder_acceptedObservation_idx" ON public."ImportSourceOrder" USING btree ("acceptedObservationId");

CREATE INDEX "ImportSourceOrder_purchase_idx" ON public."ImportSourceOrder" USING btree ("purchaseId");

CREATE UNIQUE INDEX "ImportSourceOrder_source_order_key" ON public."ImportSourceOrder" USING btree ("sourceClaimId", "orderKey") WHERE ("purchaseId" IS NOT NULL);

CREATE INDEX "ImportSourceProduct_product_idx" ON public."ImportSourceProduct" USING btree ("productId");

CREATE UNIQUE INDEX "ImportSourceProduct_sourceOrder_line_key" ON public."ImportSourceProduct" USING btree ("sourceOrderId", "lineIndex");

CREATE INDEX "Ingredient_createdAt_idx" ON public."Ingredient" USING btree ("createdAt");

CREATE INDEX "Ingredient_name_active_idx" ON public."Ingredient" USING btree (name) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Ingredient_name_gin_idx" ON public."Ingredient" USING gin (name public.gin_trgm_ops);

CREATE UNIQUE INDEX "Ingredient_name_key" ON public."Ingredient" USING btree (lower(name)) WHERE (("deletedAt" IS NULL) AND ("recipeId" IS NULL));

CREATE INDEX "Ingredient_recipeId_idx" ON public."Ingredient" USING btree ("recipeId");

CREATE UNIQUE INDEX "Ingredient_recipeId_key" ON public."Ingredient" USING btree ("recipeId") WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "Ingredient_shortcode_unique" ON public."Ingredient" USING btree (shortcode);

CREATE INDEX "InventoryEntry_createdAt_idx" ON public."InventoryEntry" USING btree ("createdAt");

CREATE INDEX "InventoryEntry_locationId_idx" ON public."InventoryEntry" USING btree ("locationId");

CREATE INDEX "InventoryEntry_owner_idx" ON public."InventoryEntry" USING btree ("ownerLedgerPartyId");

CREATE INDEX "InventoryEntry_productId_idx" ON public."InventoryEntry" USING btree ("productId");

CREATE UNIQUE INDEX "InventoryEntry_productId_locationId_key" ON public."InventoryEntry" USING btree ("productId", "locationId", placement, "ownershipMode", COALESCE("ownerLedgerPartyId", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "InventoryEntry_shortcode_unique" ON public."InventoryEntry" USING btree (shortcode);

CREATE UNIQUE INDEX "LedgerParty_household_singleton_key" ON public."LedgerParty" USING btree (kind) WHERE (("deletedAt" IS NULL) AND (kind = 'household'::text));

CREATE INDEX "LedgerParty_kind_idx" ON public."LedgerParty" USING btree (kind);

CREATE UNIQUE INDEX "LedgerParty_member_user_key" ON public."LedgerParty" USING btree ("userId") WHERE (("deletedAt" IS NULL) AND ("userId" IS NOT NULL));

CREATE UNIQUE INDEX "LedgerParty_shortcode_unique" ON public."LedgerParty" USING btree (shortcode);

CREATE INDEX "LedgerSourceClaim_expenseId_idx" ON public."LedgerSourceClaim" USING btree ("expenseId");

CREATE INDEX "LedgerSourceClaim_ledgerTransferId_idx" ON public."LedgerSourceClaim" USING btree ("ledgerTransferId");

CREATE UNIQUE INDEX "LedgerSourceClaim_source_sourceKey_key" ON public."LedgerSourceClaim" USING btree (source, "sourceKey");

CREATE INDEX "LedgerTransfer_date_idx" ON public."LedgerTransfer" USING btree (date);

CREATE INDEX "LedgerTransfer_fromPartyId_idx" ON public."LedgerTransfer" USING btree ("fromPartyId");

CREATE UNIQUE INDEX "LedgerTransfer_shortcode_unique" ON public."LedgerTransfer" USING btree (shortcode);

CREATE INDEX "LedgerTransfer_toPartyId_idx" ON public."LedgerTransfer" USING btree ("toPartyId");

CREATE INDEX "Location_createdAt_idx" ON public."Location" USING btree ("createdAt");

CREATE INDEX "Location_lastBulkInventory_idx" ON public."Location" USING btree ("lastBulkInventory");

CREATE INDEX "Location_name_active_idx" ON public."Location" USING btree (name) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Location_name_gin_idx" ON public."Location" USING gin (name public.gin_trgm_ops);

CREATE INDEX "Location_name_idx" ON public."Location" USING btree (name);

CREATE UNIQUE INDEX "Location_name_key" ON public."Location" USING btree (lower(name)) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Location_parentId_idx" ON public."Location" USING btree ("parentId");

CREATE INDEX "Location_productId_idx" ON public."Location" USING btree ("productId");

CREATE UNIQUE INDEX "Location_shortcode_unique" ON public."Location" USING btree (shortcode);

CREATE INDEX "Location_tags_idx" ON public."Location" USING gin (tags);

CREATE INDEX "Location_type_active_idx" ON public."Location" USING btree (type) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Location_type_name_idx" ON public."Location" USING btree (type, name);

CREATE UNIQUE INDEX "MailboxCursor_party_provider_mailbox_key" ON public."MailboxCursor" USING btree ("ledgerPartyId", provider, "mailboxId");

CREATE INDEX "McpToolCall_client_occurredAt_idx" ON public."McpToolCall" USING btree ("clientId", "occurredAt" DESC NULLS LAST);

CREATE INDEX "McpToolCall_entity_occurredAt_idx" ON public."McpToolCall" USING btree ("entityKind", "occurredAt" DESC NULLS LAST);

CREATE INDEX "McpToolCall_outcome_idx" ON public."McpToolCall" USING btree (outcome);

CREATE INDEX "McpToolCall_release_idx" ON public."McpToolCall" USING btree (release);

CREATE INDEX "McpToolCall_runId_idx" ON public."McpToolCall" USING btree ("runId") WHERE ("runId" IS NOT NULL);

CREATE INDEX "McpToolCall_tool_occurredAt_idx" ON public."McpToolCall" USING btree ("toolName", "occurredAt" DESC NULLS LAST);

CREATE INDEX "McpToolCall_user_occurredAt_idx" ON public."McpToolCall" USING btree ("userId", "occurredAt" DESC NULLS LAST);

CREATE INDEX "MealFoodEntry_ingredientId_idx" ON public."MealFoodEntry" USING btree ("ingredientId");

CREATE INDEX "MealFoodEntry_ledgerPartyId_idx" ON public."MealFoodEntry" USING btree ("ledgerPartyId");

CREATE INDEX "MealFoodEntry_mealId_idx" ON public."MealFoodEntry" USING btree ("mealId");

CREATE INDEX "MealFoodEntry_productId_idx" ON public."MealFoodEntry" USING btree ("productId");

CREATE INDEX "MealRecipePortion_ledgerPartyId_idx" ON public."MealRecipePortion" USING btree ("ledgerPartyId");

CREATE UNIQUE INDEX "MealRecipePortion_live_source_target_eater_key" ON public."MealRecipePortion" USING btree ("mealRecipeId", "mealId", "ledgerPartyId") WHERE ("deletedAt" IS NULL);

CREATE INDEX "MealRecipePortion_mealId_idx" ON public."MealRecipePortion" USING btree ("mealId");

CREATE INDEX "MealRecipePortion_mealRecipeId_idx" ON public."MealRecipePortion" USING btree ("mealRecipeId");

CREATE INDEX "MealRecipe_mealId_idx" ON public."MealRecipe" USING btree ("mealId");

CREATE INDEX "MealRecipe_recipeId_idx" ON public."MealRecipe" USING btree ("recipeId");

CREATE INDEX "Meal_date_active_idx" ON public."Meal" USING btree (date) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "Meal_shortcode_unique" ON public."Meal" USING btree (shortcode);

CREATE UNIQUE INDEX "MerchantVendorRule_party_merchant_key" ON public."MerchantVendorRule" USING btree ("ledgerPartyId", "normalizedMerchant");

CREATE UNIQUE INDEX "OrderMailAttachment_provider_key" ON public."OrderMailAttachment" USING btree ("orderMailId", "providerAttachmentId");

CREATE INDEX "OrderMailEvent_order_idx" ON public."OrderMailEvent" USING btree ("orderId");

CREATE UNIQUE INDEX "OrderMailEvent_source_key" ON public."OrderMailEvent" USING btree ("orderMailId", "sourceKey");

CREATE INDEX "PhotoGroupProposal_location_idx" ON public."PhotoGroupProposal" USING btree ("inventoryLocationId");

CREATE INDEX "PhotoGroupProposal_product_idx" ON public."PhotoGroupProposal" USING btree ("productId");

CREATE UNIQUE INDEX "PhotoGroupProposal_run_group_key" ON public."PhotoGroupProposal" USING btree ("runId", "groupKey");

CREATE INDEX "PhotoRunImage_device_idx" ON public."PhotoRunImage" USING btree ("deviceWorkDeviceId") WHERE ("deviceWorkDeviceId" IS NOT NULL);

CREATE INDEX "PhotoRunImage_image_idx" ON public."PhotoRunImage" USING btree ("imageId");

CREATE UNIQUE INDEX "PhotoRunImage_run_image_work_key" ON public."PhotoRunImage" USING btree ("runId", "imageId", "workKey");

CREATE INDEX "Plant_gardenGuideKey_idx" ON public."Plant" USING btree ("gardenGuideKey");

CREATE INDEX "Plant_ingredientId_idx" ON public."Plant" USING btree ("ingredientId");

CREATE UNIQUE INDEX "Plant_shortcode_unique" ON public."Plant" USING btree (shortcode);

CREATE INDEX "Planting_locationId_idx" ON public."Planting" USING btree ("locationId");

CREATE INDEX "Planting_plantId_idx" ON public."Planting" USING btree ("plantId");

CREATE UNIQUE INDEX "Planting_shortcode_unique" ON public."Planting" USING btree (shortcode);

CREATE INDEX "Planting_sourceProductId_idx" ON public."Planting" USING btree ("sourceProductId");

CREATE INDEX "Planting_status_idx" ON public."Planting" USING btree (status);

CREATE INDEX "Planting_taskId_idx" ON public."Planting" USING btree ("taskId");

CREATE INDEX "ProductCategory_feature_idx" ON public."ProductCategory" USING btree (feature);

CREATE UNIQUE INDEX "ProductCategory_feature_live_unique" ON public."ProductCategory" USING btree (feature) WHERE (("deletedAt" IS NULL) AND (feature IS NOT NULL));

CREATE INDEX "ProductCategory_parentId_idx" ON public."ProductCategory" USING btree ("parentId");

CREATE UNIQUE INDEX "ProductCategory_parent_name_key" ON public."ProductCategory" USING btree ("parentId", name) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "ProductCategory_shortcode_unique" ON public."ProductCategory" USING btree (shortcode);

CREATE INDEX "ProductCategory_spendingCategoryId_idx" ON public."ProductCategory" USING btree ("spendingCategoryId");

CREATE INDEX "ProductConversionCoverage_island_idx" ON public."ProductConversionCoverage" USING btree ("islandCount");

CREATE INDEX "ProductConversionCoverage_status_idx" ON public."ProductConversionCoverage" USING btree (status);

CREATE INDEX "ProductConversionCoverage_tier_idx" ON public."ProductConversionCoverage" USING btree ("coverageTier");

CREATE INDEX "ProductUnitMapping_productId_idx" ON public."ProductUnitMapping" USING btree ("productId");

CREATE INDEX "Product_categoryId_idx" ON public."Product" USING btree ("categoryId");

CREATE INDEX "Product_createdAt_idx" ON public."Product" USING btree ("createdAt");

CREATE INDEX "Product_growsPlantId_idx" ON public."Product" USING btree ("growsPlantId");

CREATE INDEX "Product_ingredientId_idx" ON public."Product" USING btree ("ingredientId");

CREATE INDEX "Product_manufacturer_active_idx" ON public."Product" USING btree (manufacturer) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Product_manufacturer_gin_idx" ON public."Product" USING gin (manufacturer public.gin_trgm_ops);

CREATE INDEX "Product_name_active_idx" ON public."Product" USING btree (name) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Product_name_gin_idx" ON public."Product" USING gin (name public.gin_trgm_ops);

CREATE INDEX "Product_name_manufacturer_idx" ON public."Product" USING btree (name, manufacturer);

CREATE UNIQUE INDEX "Product_name_manufacturer_key" ON public."Product" USING btree (name, manufacturer) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "Product_shortcode_unique" ON public."Product" USING btree (shortcode);

CREATE INDEX "Project_assigneeId_idx" ON public."Project" USING btree ("assigneeId");

CREATE INDEX "Project_kind_idx" ON public."Project" USING btree (kind);

CREATE INDEX "Project_name_active_idx" ON public."Project" USING btree (name) WHERE ("deletedAt" IS NULL);

CREATE INDEX "Project_name_gin_idx" ON public."Project" USING gin (name public.gin_trgm_ops);

CREATE INDEX "Project_parentProjectId_idx" ON public."Project" USING btree ("parentProjectId");

CREATE UNIQUE INDEX "Project_shortcode_unique" ON public."Project" USING btree (shortcode);

CREATE INDEX "Project_startDate_idx" ON public."Project" USING btree ("startDate");

CREATE INDEX "Project_status_idx" ON public."Project" USING btree (status);

CREATE INDEX "PurchasePaymentEvidence_purchase_idx" ON public."PurchasePaymentEvidence" USING btree ("purchaseId");

CREATE UNIQUE INDEX "PurchasePaymentEvidence_source_purchase_index_key" ON public."PurchasePaymentEvidence" USING btree ("sourceClaimId", "purchaseId", "evidenceIndex");

CREATE INDEX "Purchase_date_idx" ON public."Purchase" USING btree (date);

CREATE INDEX "Purchase_defaultProjectId_idx" ON public."Purchase" USING btree ("defaultProjectId");

CREATE INDEX "Purchase_displayLabel_gin_idx" ON public."Purchase" USING gin ("displayLabel" public.gin_trgm_ops);

CREATE INDEX "Purchase_orderId_gin_idx" ON public."Purchase" USING gin ("orderId" public.gin_trgm_ops);

CREATE INDEX "Purchase_purchaserOverrideId_idx" ON public."Purchase" USING btree ("purchaserOverrideId");

CREATE INDEX "Purchase_runId_idx" ON public."Purchase" USING btree ("runId");

CREATE UNIQUE INDEX "Purchase_shortcode_unique" ON public."Purchase" USING btree (shortcode);

CREATE INDEX "Purchase_spendingCategoryId_idx" ON public."Purchase" USING btree ("spendingCategoryId");

CREATE INDEX "Purchase_vendorAccountId_idx" ON public."Purchase" USING btree ("vendorAccountId");

CREATE INDEX "Purchase_vendorId_idx" ON public."Purchase" USING btree ("vendorId");

CREATE UNIQUE INDEX "Purchase_vendorId_orderId_key" ON public."Purchase" USING btree ("vendorId", "orderId") WHERE (("orderId" IS NOT NULL) AND ("deletedAt" IS NULL));

CREATE INDEX "RecipeSectionIngredient_ingredientId_idx" ON public."RecipeSectionIngredient" USING btree ("ingredientId");

CREATE INDEX "RecipeSectionIngredient_recipeSectionId_idx" ON public."RecipeSectionIngredient" USING btree ("recipeSectionId");

CREATE INDEX "RecipeSection_createdAt_idx" ON public."RecipeSection" USING btree ("createdAt");

CREATE INDEX "RecipeSection_recipeId_idx" ON public."RecipeSection" USING btree ("recipeId");

CREATE INDEX "Recipe_cookbookId_idx" ON public."Recipe" USING btree ("cookbookId");

CREATE UNIQUE INDEX "Recipe_cookbookId_name_key" ON public."Recipe" USING btree ("cookbookId", name) WHERE (("cookbookId" IS NOT NULL) AND ("deletedAt" IS NULL));

CREATE INDEX "Recipe_created_at_desc_idx" ON public."Recipe" USING btree ("createdAt" DESC NULLS LAST);

CREATE INDEX "Recipe_forkedFromRecipeId_idx" ON public."Recipe" USING btree ("forkedFromRecipeId");

CREATE INDEX "Recipe_name_active_idx" ON public."Recipe" USING btree (name) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "Recipe_name_key" ON public."Recipe" USING btree (name) WHERE (("deletedAt" IS NULL) AND ("sourceType" IS DISTINCT FROM 'Book'::text) AND ("sourceType" IS DISTINCT FROM 'Notion'::text));

CREATE UNIQUE INDEX "Recipe_shortcode_unique" ON public."Recipe" USING btree (shortcode);

CREATE INDEX "Recipe_sourceType_idx" ON public."Recipe" USING btree ("sourceType");

CREATE INDEX "Recipe_totals_stale_idx" ON public."Recipe" USING btree ("totalsComputedAt") WHERE ("totalsComputedAt" IS NULL);

CREATE UNIQUE INDEX "RunApproval_run_operation_key" ON public."RunApproval" USING btree ("runId", "operationId");

CREATE INDEX "RunApproval_run_state_idx" ON public."RunApproval" USING btree ("runId", state);

CREATE INDEX "RunControlEvent_run_created_idx" ON public."RunControlEvent" USING btree ("runId", "createdAt");

CREATE UNIQUE INDEX "RunFinding_open_evidence_key" ON public."RunFinding" USING btree ("ledgerPartyId", "entityKind", "entityId", kind, "evidenceFingerprint") WHERE (status = 'open'::text);

CREATE INDEX "RunFinding_status_idx" ON public."RunFinding" USING btree (status, "createdAt" DESC NULLS LAST);

CREATE UNIQUE INDEX "RunOperation_run_operation_key" ON public."RunOperation" USING btree ("runId", "operationId");

CREATE INDEX "RunOperation_run_state_idx" ON public."RunOperation" USING btree ("runId", state, id);

CREATE INDEX "RunPushRegistration_device_idx" ON public."RunPushRegistration" USING btree ("deviceId");

CREATE UNIQUE INDEX "RunPushRegistration_run_device_kind_key" ON public."RunPushRegistration" USING btree ("runId", "deviceId", kind);

CREATE INDEX "RunStep_child_idx" ON public."RunStep" USING btree ("childRunId") WHERE ("childRunId" IS NOT NULL);

CREATE UNIQUE INDEX "RunStep_run_key" ON public."RunStep" USING btree ("runId", key);

CREATE UNIQUE INDEX "Run_clientKey_unique" ON public."Run" USING btree ("clientKey") WHERE ("clientKey" IS NOT NULL);

CREATE UNIQUE INDEX "Run_dispatch_event_unique" ON public."Run" USING btree ("dispatchEventId") WHERE ("dispatchEventId" IS NOT NULL);

CREATE INDEX "Run_live_status_failure_purpose_idx" ON public."Run" USING btree (status, "failureCode", purpose) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "Run_one_active_derived_refresh" ON public."Run" USING btree (purpose) WHERE ((purpose = 'derived_refresh'::text) AND (status = ANY (ARRAY['running'::text, 'paused_auth'::text, 'paused'::text])));

CREATE UNIQUE INDEX "Run_one_active_mail_discovery" ON public."Run" USING btree ("ledgerPartyId", COALESCE((input ->> 'mailboxId'::text), ''::text)) WHERE ((purpose = 'mail_discovery'::text) AND (status = 'running'::text));

CREATE UNIQUE INDEX "Run_one_active_maintenance" ON public."Run" USING btree (purpose) WHERE ((purpose = 'maintenance'::text) AND (status = ANY (ARRAY['running'::text, 'paused_auth'::text])));

CREATE UNIQUE INDEX "Run_one_active_vendor_account_key" ON public."Run" USING btree ("vendorAccountId") WHERE (("vendorAccountId" IS NOT NULL) AND (status = ANY (ARRAY['running'::text, 'paused'::text, 'paused_auth'::text, 'paused_offline'::text])));

CREATE INDEX "Run_parent_started_idx" ON public."Run" USING btree ("parentRunId", "startedAt");

CREATE INDEX "Run_party_started_idx" ON public."Run" USING btree ("ledgerPartyId", "startedAt" DESC NULLS LAST);

CREATE UNIQUE INDEX "Run_shortcode_unique" ON public."Run" USING btree (shortcode);

CREATE INDEX "Run_vendorAccount_started_idx" ON public."Run" USING btree ("vendorAccountId", "startedAt" DESC NULLS LAST);

CREATE UNIQUE INDEX "SearchDocument_live_entity_key" ON public."SearchDocument" USING btree ("entityKind", "entityId") WHERE ("deletedAt" IS NULL);

CREATE INDEX "SearchDocument_normalized_gist_idx" ON public."SearchDocument" USING gist ("normalizedText" public.gist_trgm_ops) WHERE ("deletedAt" IS NULL);

CREATE INDEX "SearchDocument_title_active_idx" ON public."SearchDocument" USING btree (lower(title) text_pattern_ops) WHERE ("deletedAt" IS NULL);

CREATE INDEX "SearchDocument_vector_gin_idx" ON public."SearchDocument" USING gin ("searchVector") WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "SourceOrderObservation_content_key" ON public."SourceOrderObservation" USING btree ("sourceClaimId", "orderKey", checksum, "contentFingerprint", "purchaseId");

CREATE INDEX "SourceOrderObservation_purchase_idx" ON public."SourceOrderObservation" USING btree ("purchaseId");

CREATE INDEX "SpendingCategory_parentId_idx" ON public."SpendingCategory" USING btree ("parentId");

CREATE UNIQUE INDEX "SpendingCategory_shortcode_unique" ON public."SpendingCategory" USING btree (shortcode);

CREATE UNIQUE INDEX "StatementImportRow_import_row_key" ON public."StatementImportRow" USING btree ("importId", "statementRowId");

CREATE INDEX "StatementImportRow_row_idx" ON public."StatementImportRow" USING btree ("statementRowId");

CREATE UNIQUE INDEX "StatementImport_source_fingerprint_key" ON public."StatementImport" USING btree (source, fingerprint) WHERE ("deletedAt" IS NULL);

CREATE INDEX "StatementImport_source_idx" ON public."StatementImport" USING btree (source);

CREATE INDEX "StatementRow_account_date_amount_idx" ON public."StatementRow" USING btree ("accountId", "statementDate", amount);

CREATE INDEX "StatementRow_batchId_idx" ON public."StatementRow" USING btree ("batchId");

CREATE UNIQUE INDEX "StatementRow_batch_position_key" ON public."StatementRow" USING btree ("batchId", "rowPosition") WHERE ("deletedAt" IS NULL);

CREATE INDEX "StatementRow_descriptor_date_amount_idx" ON public."StatementRow" USING btree (source, "accountDescriptor", "statementDate", "providerAmount");

CREATE INDEX "StatementRow_rawDescription_gin_idx" ON public."StatementRow" USING gin ("rawDescription" public.gin_trgm_ops);

CREATE INDEX "StatementRow_source_charge_idx" ON public."StatementRow" USING btree (source, COALESCE("legacyExternalId", "externalId")) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "StatementRow_source_externalId_key" ON public."StatementRow" USING btree (source, "externalId") WHERE ("deletedAt" IS NULL);

CREATE INDEX "StatementRow_source_providerTransactionId_idx" ON public."StatementRow" USING btree (source, "providerTransactionId");

CREATE INDEX "StatementRow_statementDate_idx" ON public."StatementRow" USING btree ("statementDate");

CREATE INDEX "StatementRow_worklist_idx" ON public."StatementRow" USING btree ("statementDate" DESC NULLS LAST) WHERE (("deletedAt" IS NULL) AND (disposition = 'open'::text) AND ("supersededByRowId" IS NULL));

CREATE INDEX "Task_assigneeId_idx" ON public."Task" USING btree ("assigneeId");

CREATE INDEX "Task_dueDate_idx" ON public."Task" USING btree ("dueDate");

CREATE INDEX "Task_parentTaskId_idx" ON public."Task" USING btree ("parentTaskId");

CREATE INDEX "Task_projectId_idx" ON public."Task" USING btree ("projectId");

CREATE UNIQUE INDEX "Task_shortcode_unique" ON public."Task" USING btree (shortcode);

CREATE INDEX "Task_status_idx" ON public."Task" USING btree (status);

CREATE INDEX "Task_subjectProductId_idx" ON public."Task" USING btree ("subjectProductId");

CREATE INDEX "UpcLookupCache_fetchedAt_idx" ON public."UpcLookupCache" USING btree ("fetchedAt");

CREATE INDEX "UpcLookupCache_status_idx" ON public."UpcLookupCache" USING btree (status);

CREATE INDEX "VendorAccount_ledgerPartyId_idx" ON public."VendorAccount" USING btree ("ledgerPartyId");

CREATE UNIQUE INDEX "VendorAccount_shortcode_unique" ON public."VendorAccount" USING btree (shortcode);

CREATE INDEX "VendorAccount_vendorId_idx" ON public."VendorAccount" USING btree ("vendorId");

CREATE UNIQUE INDEX "VendorAccount_vendor_member_key" ON public."VendorAccount" USING btree ("vendorId", "ledgerPartyId") WHERE ("deletedAt" IS NULL);

CREATE INDEX "Vendor_defaultSpendingCategoryId_idx" ON public."Vendor" USING btree ("defaultSpendingCategoryId");

CREATE UNIQUE INDEX "Vendor_name_key" ON public."Vendor" USING btree (name) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX "Vendor_shortcode_unique" ON public."Vendor" USING btree (shortcode);

CREATE INDEX "Wish_acquiredAt_idx" ON public."Wish" USING btree ("acquiredAt");

CREATE INDEX "Wish_createdAt_idx" ON public."Wish" USING btree ("createdAt");

CREATE UNIQUE INDEX "Wish_shortcode_unique" ON public."Wish" USING btree (shortcode);

CREATE INDEX oauth_access_token_authorization_code_id_idx ON public.oauth_access_token USING btree (authorization_code_id);

CREATE INDEX oauth_access_token_client_id_idx ON public.oauth_access_token USING btree (client_id);

CREATE INDEX oauth_access_token_refresh_id_idx ON public.oauth_access_token USING btree (refresh_id);

CREATE INDEX oauth_access_token_session_id_idx ON public.oauth_access_token USING btree (session_id);

CREATE INDEX oauth_access_token_user_id_idx ON public.oauth_access_token USING btree (user_id);

CREATE INDEX oauth_client_resource_client_id_idx ON public.oauth_client_resource USING btree (client_id);

CREATE UNIQUE INDEX oauth_client_resource_client_id_resource_id_unique ON public.oauth_client_resource USING btree (client_id, resource_id);

CREATE INDEX oauth_client_resource_resource_id_idx ON public.oauth_client_resource USING btree (resource_id);

CREATE INDEX oauth_client_user_id_idx ON public.oauth_client USING btree (user_id);

CREATE INDEX oauth_consent_client_id_idx ON public.oauth_consent USING btree (client_id);

CREATE INDEX oauth_consent_user_id_idx ON public.oauth_consent USING btree (user_id);

CREATE INDEX oauth_refresh_token_authorization_code_id_idx ON public.oauth_refresh_token USING btree (authorization_code_id);

CREATE INDEX oauth_refresh_token_client_id_idx ON public.oauth_refresh_token USING btree (client_id);

CREATE INDEX oauth_refresh_token_session_id_idx ON public.oauth_refresh_token USING btree (session_id);

CREATE INDEX oauth_refresh_token_user_id_idx ON public.oauth_refresh_token USING btree (user_id);

CREATE INDEX passkey_credential_id_idx ON public.passkey USING btree (credential_id);

CREATE INDEX passkey_user_id_idx ON public.passkey USING btree (user_id);

CREATE TRIGGER "AssessmentState_publish_field" BEFORE INSERT ON public."AssessmentState" FOR EACH ROW EXECUTE FUNCTION public.publish_field_assessment();

CREATE TRIGGER "Assessment_immutable" BEFORE DELETE OR UPDATE ON public."Assessment" FOR EACH ROW EXECUTE FUNCTION public.assessment_history_immutable();

CREATE TRIGGER "Email_assessment_lifecycle" AFTER DELETE OR UPDATE OF "deletedAt" ON public."Email" FOR EACH ROW EXECUTE FUNCTION public.assessment_mail_lifecycle();

CREATE CONSTRAINT TRIGGER "EntityLink_live_endpoints" AFTER INSERT OR UPDATE ON public."EntityLink" NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN ((new."deletedAt" IS NULL)) EXECUTE FUNCTION public.entity_link_require_live_endpoints();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Cookbook" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Device" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Email" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Expense" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."FinancialAccount" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."FinancialTransaction" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."GardenEntry" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Image" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."ImageProcessingJob" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Ingredient" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."InventoryEntry" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."LedgerParty" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."LedgerTransfer" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Location" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Meal" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Plant" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Planting" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Product" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."ProductCategory" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Project" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Purchase" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Recipe" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Run" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."SpendingCategory" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Task" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Vendor" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."VendorAccount" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_delete" AFTER DELETE ON public."Wish" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_delete();

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Cookbook" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('cookbook');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Device" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('device');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Email" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('email');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Expense" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('expense');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."FinancialAccount" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('financialAccount');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."FinancialTransaction" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('financialTransaction');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."GardenEntry" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('gardenEntry');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Image" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('image');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."ImageProcessingJob" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('imageJob');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Ingredient" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('ingredient');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."InventoryEntry" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('inventory');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."LedgerParty" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('ledgerParty');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."LedgerTransfer" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('ledgerTransfer');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Location" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('location');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Meal" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('meal');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Plant" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('plant');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Planting" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('planting');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Product" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('product');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."ProductCategory" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('productCategory');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Project" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('project');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Purchase" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('purchase');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Recipe" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('recipe');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Run" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('run');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."SpendingCategory" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('spendingCategory');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Task" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('task');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Vendor" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('vendor');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."VendorAccount" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('vendorAccount');

CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON public."Wish" FOR EACH ROW EXECUTE FUNCTION public.entity_identity_on_insert('wish');

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Cookbook" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Device" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Email" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Expense" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."FinancialAccount" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."FinancialTransaction" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."GardenEntry" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Image" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."ImageProcessingJob" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Ingredient" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."InventoryEntry" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."LedgerParty" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."LedgerTransfer" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Location" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Meal" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Plant" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Planting" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Product" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."ProductCategory" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Project" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Purchase" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Recipe" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Run" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."SpendingCategory" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Task" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Vendor" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."VendorAccount" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON public."Wish" FOR EACH ROW WHEN ((old."deletedAt" IS DISTINCT FROM new."deletedAt")) EXECUTE FUNCTION public.entity_identity_on_soft_delete();

CREATE TRIGGER "Feedback_immutable" BEFORE DELETE OR UPDATE ON public."Feedback" FOR EACH ROW EXECUTE FUNCTION public.assessment_history_immutable();

CREATE TRIGGER "OrderMailEvent_assessment_lifecycle" AFTER DELETE OR UPDATE OF "supersededAt" ON public."OrderMailEvent" FOR EACH ROW EXECUTE FUNCTION public.assessment_mail_lifecycle();

ALTER TABLE ONLY public."AiAnalysis"
    ADD CONSTRAINT "AiAnalysis_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."AiEvaluationRequest"
    ADD CONSTRAINT "AiEvaluationRequest_evaluationId_AiEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES public."AiEvaluation"(id);

ALTER TABLE ONLY public."AiEvaluationRequest"
    ADD CONSTRAINT "AiEvaluationRequest_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."AiEvaluation"
    ADD CONSTRAINT "AiEvaluation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."AiUsage"
    ADD CONSTRAINT "AiUsage_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."AiUsage"
    ADD CONSTRAINT "AiUsage_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."AssessmentState"
    ADD CONSTRAINT "AssessmentState_evaluationId_AiEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES public."AiEvaluation"(id);

ALTER TABLE ONLY public."AssessmentState"
    ADD CONSTRAINT "AssessmentState_history_fk" FOREIGN KEY (id) REFERENCES public."Assessment"(id);

ALTER TABLE ONLY public."AssessmentState"
    ADD CONSTRAINT "AssessmentState_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id) ON DELETE SET NULL;

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_deviceId_Device_id_fk" FOREIGN KEY ("deviceId") REFERENCES public."Device"(id) ON DELETE SET NULL;

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id) ON DELETE SET NULL;

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."AutomaticRule"
    ADD CONSTRAINT "AutomaticRule_enabledByUserId_user_id_fk" FOREIGN KEY ("enabledByUserId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."Cookbook"
    ADD CONSTRAINT "Cookbook_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Cookbook"
    ADD CONSTRAINT "Cookbook_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."DataException"
    ADD CONSTRAINT "DataException_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."DerivedDiscoveryPass"
    ADD CONSTRAINT "DerivedDiscoveryPass_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."DerivedRefreshCaptureInbox"
    ADD CONSTRAINT "DerivedRefreshCaptureInbox_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."DerivedRefreshFailure"
    ADD CONSTRAINT "DerivedRefreshFailure_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."DerivedRefreshPublication"
    ADD CONSTRAINT "DerivedRefreshPublication_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."DerivedRefreshScope"
    ADD CONSTRAINT "DerivedRefreshScope_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."DerivedRefreshScope"
    ADD CONSTRAINT "DerivedRefreshScope_workId_DerivedRefreshWork_id_fk" FOREIGN KEY ("workId") REFERENCES public."DerivedRefreshWork"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."DerivedRefreshSnapshot"
    ADD CONSTRAINT "DerivedRefreshSnapshot_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."DerivedRefreshWork"
    ADD CONSTRAINT "DerivedRefreshWork_auditId_AuditLog_id_fk" FOREIGN KEY ("auditId") REFERENCES public."AuditLog"(id);

ALTER TABLE ONLY public."DerivedRefreshWork"
    ADD CONSTRAINT "DerivedRefreshWork_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."Device"
    ADD CONSTRAINT "Device_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Device"
    ADD CONSTRAINT "Device_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Device"
    ADD CONSTRAINT "Device_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."EmailAccuracyEvaluation"
    ADD CONSTRAINT "EmailAccuracyEvaluation_ownerUserId_user_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."EmailCandidateObservation"
    ADD CONSTRAINT "EmailCandidateObservation_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES public."Email"(id);

ALTER TABLE ONLY public."EmailCandidateObservation"
    ADD CONSTRAINT "EmailCandidateObservation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."EmailClassificationObservation"
    ADD CONSTRAINT "EmailClassificationObservation_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES public."Email"(id);

ALTER TABLE ONLY public."EmailClassificationObservation"
    ADD CONSTRAINT "EmailClassificationObservation_evaluationId_AiEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES public."AiEvaluation"(id);

ALTER TABLE ONLY public."EmailClassificationObservation"
    ADD CONSTRAINT "EmailClassificationObservation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."EmailClassificationObservation"
    ADD CONSTRAINT "EmailClassificationObservation_usageId_AiUsage_id_fk" FOREIGN KEY ("usageId") REFERENCES public."AiUsage"(id);

ALTER TABLE ONLY public."EmailFinancialAssociation"
    ADD CONSTRAINT "EmailFinancialAssociation_decidedByUserId_user_id_fk" FOREIGN KEY ("decidedByUserId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."EmailFinancialAssociation"
    ADD CONSTRAINT "EmailFinancialAssociation_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES public."Email"(id);

ALTER TABLE ONLY public."EmailFinancialAssociation"
    ADD CONSTRAINT "EmailFinancialAssociation_reviewedAccountId_FinancialAccount_id" FOREIGN KEY ("reviewedAccountId") REFERENCES public."FinancialAccount"(id);

ALTER TABLE ONLY public."EmailFinancialAssociation"
    ADD CONSTRAINT "EmailFinancialAssociation_transactionId_FinancialTransaction_id" FOREIGN KEY ("transactionId") REFERENCES public."FinancialTransaction"(id);

ALTER TABLE ONLY public."EmailRetrievalFailure"
    ADD CONSTRAINT "EmailRetrievalFailure_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES public."Email"(id);

ALTER TABLE ONLY public."EmailRetrievalFailure"
    ADD CONSTRAINT "EmailRetrievalFailure_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."Email"
    ADD CONSTRAINT "Email_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Email"
    ADD CONSTRAINT "Email_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Email"
    ADD CONSTRAINT "Email_orderMailId_OrderMail_id_fk" FOREIGN KEY ("orderMailId") REFERENCES public."OrderMail"(id);

ALTER TABLE ONLY public."Email"
    ADD CONSTRAINT "Email_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."EntityAttachment"
    ADD CONSTRAINT "EntityAttachment_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."EntityAttachment"
    ADD CONSTRAINT "EntityAttachment_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."EntityEmbedding"
    ADD CONSTRAINT "EntityEmbedding_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."EntityExternalId"
    ADD CONSTRAINT "EntityExternalId_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."EntityExternalId"
    ADD CONSTRAINT "EntityExternalId_source_ExternalSource_slug_fk" FOREIGN KEY (source) REFERENCES public."ExternalSource"(slug) ON UPDATE CASCADE;

ALTER TABLE ONLY public."EntityLink"
    ADD CONSTRAINT "EntityLink_from_fk" FOREIGN KEY ("fromEntityId", "fromKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."EntityLink"
    ADD CONSTRAINT "EntityLink_to_fk" FOREIGN KEY ("toEntityId", "toKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."Entity"
    ADD CONSTRAINT "Entity_mergedIntoId_Entity_id_fk" FOREIGN KEY ("mergedIntoId") REFERENCES public."Entity"(id);

ALTER TABLE ONLY public."ExpenseAttribution"
    ADD CONSTRAINT "ExpenseAttribution_expenseId_Expense_id_fk" FOREIGN KEY ("expenseId") REFERENCES public."Expense"(id);

ALTER TABLE ONLY public."ExpenseAttribution"
    ADD CONSTRAINT "ExpenseAttribution_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Expense"
    ADD CONSTRAINT "Expense_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Expense"
    ADD CONSTRAINT "Expense_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."Expense"
    ADD CONSTRAINT "Expense_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES public."Project"(id);

ALTER TABLE ONLY public."Expense"
    ADD CONSTRAINT "Expense_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES public."Purchase"(id);

ALTER TABLE ONLY public."Expense"
    ADD CONSTRAINT "Expense_spendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("spendingCategoryId") REFERENCES public."SpendingCategory"(id);

ALTER TABLE ONLY public."ExternalSource"
    ADD CONSTRAINT "ExternalSource_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."Feedback"
    ADD CONSTRAINT "Feedback_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES public."Assessment"(id);

ALTER TABLE ONLY public."FinancialAccount"
    ADD CONSTRAINT "FinancialAccount_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."FinancialAccount"
    ADD CONSTRAINT "FinancialAccount_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."FinancialAccount"
    ADD CONSTRAINT "FinancialAccount_primaryCardholderId_LedgerParty_id_fk" FOREIGN KEY ("primaryCardholderId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."FinancialAccount"
    ADD CONSTRAINT "FinancialAccount_providerVendorId_Vendor_id_fk" FOREIGN KEY ("providerVendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."FinancialTransactionAllocation"
    ADD CONSTRAINT "FinancialTransactionAllocation_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES public."Purchase"(id);

ALTER TABLE ONLY public."FinancialTransactionAllocation"
    ADD CONSTRAINT "FinancialTransactionAllocation_transactionId_FinancialTransacti" FOREIGN KEY ("transactionId") REFERENCES public."FinancialTransaction"(id);

ALTER TABLE ONLY public."FinancialTransaction"
    ADD CONSTRAINT "FinancialTransaction_accountId_FinancialAccount_id_fk" FOREIGN KEY ("accountId") REFERENCES public."FinancialAccount"(id);

ALTER TABLE ONLY public."FinancialTransaction"
    ADD CONSTRAINT "FinancialTransaction_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."FinancialTransaction"
    ADD CONSTRAINT "FinancialTransaction_ledgerTransferId_LedgerTransfer_id_fk" FOREIGN KEY ("ledgerTransferId") REFERENCES public."LedgerTransfer"(id);

ALTER TABLE ONLY public."FinancialTransaction"
    ADD CONSTRAINT "FinancialTransaction_spendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("spendingCategoryId") REFERENCES public."SpendingCategory"(id);

ALTER TABLE ONLY public."GardenEntry"
    ADD CONSTRAINT "GardenEntry_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."GardenEntry"
    ADD CONSTRAINT "GardenEntry_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES public."Location"(id);

ALTER TABLE ONLY public."ImageDerivative"
    ADD CONSTRAINT "ImageDerivative_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."ImageProcessingAttempt"
    ADD CONSTRAINT "ImageProcessingAttempt_jobId_ImageProcessingJob_id_fk" FOREIGN KEY ("jobId") REFERENCES public."ImageProcessingJob"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."ImageProcessingAttempt"
    ADD CONSTRAINT "ImageProcessingAttempt_submissionId_ImageProcessingSubmission_i" FOREIGN KEY ("submissionId") REFERENCES public."ImageProcessingSubmission"(id) ON DELETE SET NULL;

ALTER TABLE ONLY public."ImageProcessingEvent"
    ADD CONSTRAINT "ImageProcessingEvent_jobId_ImageProcessingJob_id_fk" FOREIGN KEY ("jobId") REFERENCES public."ImageProcessingJob"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."ImageProcessingJob"
    ADD CONSTRAINT "ImageProcessingJob_derivativeId_ImageDerivative_id_fk" FOREIGN KEY ("derivativeId") REFERENCES public."ImageDerivative"(id);

ALTER TABLE ONLY public."ImageProcessingJob"
    ADD CONSTRAINT "ImageProcessingJob_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."ImageProcessingJob"
    ADD CONSTRAINT "ImageProcessingJob_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."ImageProcessingJob"
    ADD CONSTRAINT "ImageProcessingJob_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."ImageProcessingJob"
    ADD CONSTRAINT "ImageProcessingJob_submissionId_ImageProcessingSubmission_id_fk" FOREIGN KEY ("submissionId") REFERENCES public."ImageProcessingSubmission"(id);

ALTER TABLE ONLY public."ImageProcessingSubmissionJob"
    ADD CONSTRAINT "ImageProcessingSubmissionJob_jobId_ImageProcessingJob_id_fk" FOREIGN KEY ("jobId") REFERENCES public."ImageProcessingJob"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."ImageProcessingSubmissionJob"
    ADD CONSTRAINT "ImageProcessingSubmissionJob_submissionId_ImageProcessingSubmis" FOREIGN KEY ("submissionId") REFERENCES public."ImageProcessingSubmission"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."ImageSighting"
    ADD CONSTRAINT "ImageSighting_deviceId_Device_id_fk" FOREIGN KEY ("deviceId") REFERENCES public."Device"(id);

ALTER TABLE ONLY public."ImageSighting"
    ADD CONSTRAINT "ImageSighting_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."ImageSighting"
    ADD CONSTRAINT "ImageSighting_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Image"
    ADD CONSTRAINT "Image_capturedByPartyId_LedgerParty_id_fk" FOREIGN KEY ("capturedByPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Image"
    ADD CONSTRAINT "Image_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."ImportPreparedLine"
    ADD CONSTRAINT "ImportPreparedLine_preparedOrderId_ImportPreparedOrder_id_fk" FOREIGN KEY ("preparedOrderId") REFERENCES public."ImportPreparedOrder"(id);

ALTER TABLE ONLY public."ImportPreparedOrder"
    ADD CONSTRAINT "ImportPreparedOrder_primaryDocumentImageId_Image_id_fk" FOREIGN KEY ("primaryDocumentImageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."ImportPreparedOrder"
    ADD CONSTRAINT "ImportPreparedOrder_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."ImportPreparedOrder"
    ADD CONSTRAINT "ImportPreparedOrder_screenshotImageId_Image_id_fk" FOREIGN KEY ("screenshotImageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."ImportPreparedOrder"
    ADD CONSTRAINT "ImportPreparedOrder_targetPurchaseId_Purchase_id_fk" FOREIGN KEY ("targetPurchaseId") REFERENCES public."Purchase"(id);

ALTER TABLE ONLY public."ImportPreparedOrder"
    ADD CONSTRAINT "ImportPreparedOrder_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."ImportSourceClaim"
    ADD CONSTRAINT "ImportSourceClaim_canonicalClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("canonicalClaimId") REFERENCES public."ImportSourceClaim"(id);

ALTER TABLE ONLY public."ImportSourceClaim"
    ADD CONSTRAINT "ImportSourceClaim_firstRunId_Run_id_fk" FOREIGN KEY ("firstRunId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."ImportSourceClaim"
    ADD CONSTRAINT "ImportSourceClaim_lastRunId_Run_id_fk" FOREIGN KEY ("lastRunId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."ImportSourceClaim"
    ADD CONSTRAINT "ImportSourceClaim_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."ImportSourceClaim"
    ADD CONSTRAINT "ImportSourceClaim_vendorAccountId_VendorAccount_id_fk" FOREIGN KEY ("vendorAccountId") REFERENCES public."VendorAccount"(id);

ALTER TABLE ONLY public."ImportSourceOrder"
    ADD CONSTRAINT "ImportSourceOrder_acceptedObservationId_SourceOrderObservation_" FOREIGN KEY ("acceptedObservationId") REFERENCES public."SourceOrderObservation"(id);

ALTER TABLE ONLY public."ImportSourceOrder"
    ADD CONSTRAINT "ImportSourceOrder_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES public."Purchase"(id);

ALTER TABLE ONLY public."ImportSourceOrder"
    ADD CONSTRAINT "ImportSourceOrder_sourceClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("sourceClaimId") REFERENCES public."ImportSourceClaim"(id);

ALTER TABLE ONLY public."ImportSourceProduct"
    ADD CONSTRAINT "ImportSourceProduct_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."ImportSourceProduct"
    ADD CONSTRAINT "ImportSourceProduct_sourceOrderId_ImportSourceOrder_id_fk" FOREIGN KEY ("sourceOrderId") REFERENCES public."ImportSourceOrder"(id);

ALTER TABLE ONLY public."Ingredient"
    ADD CONSTRAINT "Ingredient_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Ingredient"
    ADD CONSTRAINT "Ingredient_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES public."Recipe"(id);

ALTER TABLE ONLY public."InventoryEntry"
    ADD CONSTRAINT "InventoryEntry_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."InventoryEntry"
    ADD CONSTRAINT "InventoryEntry_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES public."Location"(id);

ALTER TABLE ONLY public."InventoryEntry"
    ADD CONSTRAINT "InventoryEntry_ownerLedgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ownerLedgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."InventoryEntry"
    ADD CONSTRAINT "InventoryEntry_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."LedgerParty"
    ADD CONSTRAINT "LedgerParty_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."LedgerParty"
    ADD CONSTRAINT "LedgerParty_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."LedgerSourceClaim"
    ADD CONSTRAINT "LedgerSourceClaim_expenseId_Expense_id_fk" FOREIGN KEY ("expenseId") REFERENCES public."Expense"(id);

ALTER TABLE ONLY public."LedgerSourceClaim"
    ADD CONSTRAINT "LedgerSourceClaim_ledgerTransferId_LedgerTransfer_id_fk" FOREIGN KEY ("ledgerTransferId") REFERENCES public."LedgerTransfer"(id);

ALTER TABLE ONLY public."LedgerSourceClaim"
    ADD CONSTRAINT "LedgerSourceClaim_source_ExternalSource_slug_fk" FOREIGN KEY (source) REFERENCES public."ExternalSource"(slug) ON UPDATE CASCADE;

ALTER TABLE ONLY public."LedgerTransfer"
    ADD CONSTRAINT "LedgerTransfer_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."LedgerTransfer"
    ADD CONSTRAINT "LedgerTransfer_fromPartyId_LedgerParty_id_fk" FOREIGN KEY ("fromPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."LedgerTransfer"
    ADD CONSTRAINT "LedgerTransfer_toPartyId_LedgerParty_id_fk" FOREIGN KEY ("toPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Location"
    ADD CONSTRAINT "Location_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Location"
    ADD CONSTRAINT "Location_parentId_Location_id_fk" FOREIGN KEY ("parentId") REFERENCES public."Location"(id);

ALTER TABLE ONLY public."Location"
    ADD CONSTRAINT "Location_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."MailboxCursor"
    ADD CONSTRAINT "MailboxCursor_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."McpToolCall"
    ADD CONSTRAINT "McpToolCall_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id) ON DELETE SET NULL;

ALTER TABLE ONLY public."McpToolCall"
    ADD CONSTRAINT "McpToolCall_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."MealFoodEntry"
    ADD CONSTRAINT "MealFoodEntry_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES public."Ingredient"(id);

ALTER TABLE ONLY public."MealFoodEntry"
    ADD CONSTRAINT "MealFoodEntry_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."MealFoodEntry"
    ADD CONSTRAINT "MealFoodEntry_mealId_Meal_id_fk" FOREIGN KEY ("mealId") REFERENCES public."Meal"(id);

ALTER TABLE ONLY public."MealFoodEntry"
    ADD CONSTRAINT "MealFoodEntry_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."MealRecipePortion"
    ADD CONSTRAINT "MealRecipePortion_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."MealRecipePortion"
    ADD CONSTRAINT "MealRecipePortion_mealId_Meal_id_fk" FOREIGN KEY ("mealId") REFERENCES public."Meal"(id);

ALTER TABLE ONLY public."MealRecipePortion"
    ADD CONSTRAINT "MealRecipePortion_mealRecipeId_MealRecipe_id_fk" FOREIGN KEY ("mealRecipeId") REFERENCES public."MealRecipe"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."MealRecipe"
    ADD CONSTRAINT "MealRecipe_mealId_Meal_id_fk" FOREIGN KEY ("mealId") REFERENCES public."Meal"(id);

ALTER TABLE ONLY public."MealRecipe"
    ADD CONSTRAINT "MealRecipe_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES public."Recipe"(id);

ALTER TABLE ONLY public."Meal"
    ADD CONSTRAINT "Meal_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."MerchantVendorRule"
    ADD CONSTRAINT "MerchantVendorRule_confirmedByUserId_user_id_fk" FOREIGN KEY ("confirmedByUserId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."MerchantVendorRule"
    ADD CONSTRAINT "MerchantVendorRule_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."MerchantVendorRule"
    ADD CONSTRAINT "MerchantVendorRule_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."OrderMailAttachment"
    ADD CONSTRAINT "OrderMailAttachment_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."OrderMailAttachment"
    ADD CONSTRAINT "OrderMailAttachment_orderMailId_OrderMail_id_fk" FOREIGN KEY ("orderMailId") REFERENCES public."OrderMail"(id);

ALTER TABLE ONLY public."OrderMailEvent"
    ADD CONSTRAINT "OrderMailEvent_orderMailId_OrderMail_id_fk" FOREIGN KEY ("orderMailId") REFERENCES public."OrderMail"(id);

ALTER TABLE ONLY public."OrderMail"
    ADD CONSTRAINT "OrderMail_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."OrderMail"
    ADD CONSTRAINT "OrderMail_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."PhotoGroupProposal"
    ADD CONSTRAINT "PhotoGroupProposal_inventoryLocationId_Location_id_fk" FOREIGN KEY ("inventoryLocationId") REFERENCES public."Location"(id);

ALTER TABLE ONLY public."PhotoGroupProposal"
    ADD CONSTRAINT "PhotoGroupProposal_inventoryOwnerPartyId_LedgerParty_id_fk" FOREIGN KEY ("inventoryOwnerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."PhotoGroupProposal"
    ADD CONSTRAINT "PhotoGroupProposal_productCreateCategoryId_fk" FOREIGN KEY ("productCreateCategoryId") REFERENCES public."ProductCategory"(id);

ALTER TABLE ONLY public."PhotoGroupProposal"
    ADD CONSTRAINT "PhotoGroupProposal_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."PhotoGroupProposal"
    ADD CONSTRAINT "PhotoGroupProposal_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."PhotoRunImage"
    ADD CONSTRAINT "PhotoRunImage_deviceWorkDeviceId_Device_id_fk" FOREIGN KEY ("deviceWorkDeviceId") REFERENCES public."Device"(id) ON DELETE SET NULL;

ALTER TABLE ONLY public."PhotoRunImage"
    ADD CONSTRAINT "PhotoRunImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."PhotoRunImage"
    ADD CONSTRAINT "PhotoRunImage_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."Plant"
    ADD CONSTRAINT "Plant_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Plant"
    ADD CONSTRAINT "Plant_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES public."Ingredient"(id);

ALTER TABLE ONLY public."Planting"
    ADD CONSTRAINT "Planting_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Planting"
    ADD CONSTRAINT "Planting_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES public."Location"(id);

ALTER TABLE ONLY public."Planting"
    ADD CONSTRAINT "Planting_plantId_Plant_id_fk" FOREIGN KEY ("plantId") REFERENCES public."Plant"(id);

ALTER TABLE ONLY public."Planting"
    ADD CONSTRAINT "Planting_sourceProductId_Product_id_fk" FOREIGN KEY ("sourceProductId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."Planting"
    ADD CONSTRAINT "Planting_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES public."Task"(id);

ALTER TABLE ONLY public."ProductCategory"
    ADD CONSTRAINT "ProductCategory_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."ProductCategory"
    ADD CONSTRAINT "ProductCategory_parentId_ProductCategory_id_fk" FOREIGN KEY ("parentId") REFERENCES public."ProductCategory"(id);

ALTER TABLE ONLY public."ProductCategory"
    ADD CONSTRAINT "ProductCategory_spendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("spendingCategoryId") REFERENCES public."SpendingCategory"(id);

ALTER TABLE ONLY public."ProductConversionCoverage"
    ADD CONSTRAINT "ProductConversionCoverage_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."ProductUnitMapping"
    ADD CONSTRAINT "ProductUnitMapping_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_categoryId_ProductCategory_id_fk" FOREIGN KEY ("categoryId") REFERENCES public."ProductCategory"(id);

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_growsPlantId_Plant_id_fk" FOREIGN KEY ("growsPlantId") REFERENCES public."Plant"(id);

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES public."Ingredient"(id);

ALTER TABLE ONLY public."Project"
    ADD CONSTRAINT "Project_assigneeId_LedgerParty_id_fk" FOREIGN KEY ("assigneeId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Project"
    ADD CONSTRAINT "Project_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Project"
    ADD CONSTRAINT "Project_parentProjectId_Project_id_fk" FOREIGN KEY ("parentProjectId") REFERENCES public."Project"(id);

ALTER TABLE ONLY public."PurchasePaymentEvidence"
    ADD CONSTRAINT "PurchasePaymentEvidence_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES public."Purchase"(id);

ALTER TABLE ONLY public."PurchasePaymentEvidence"
    ADD CONSTRAINT "PurchasePaymentEvidence_sourceClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("sourceClaimId") REFERENCES public."ImportSourceClaim"(id);

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_defaultProjectId_Project_id_fk" FOREIGN KEY ("defaultProjectId") REFERENCES public."Project"(id);

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_purchaserOverrideId_LedgerParty_id_fk" FOREIGN KEY ("purchaserOverrideId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_spendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("spendingCategoryId") REFERENCES public."SpendingCategory"(id);

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_vendorAccountId_VendorAccount_id_fk" FOREIGN KEY ("vendorAccountId") REFERENCES public."VendorAccount"(id);

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."RecipeSectionIngredient"
    ADD CONSTRAINT "RecipeSectionIngredient_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES public."Ingredient"(id);

ALTER TABLE ONLY public."RecipeSectionIngredient"
    ADD CONSTRAINT "RecipeSectionIngredient_recipeSectionId_RecipeSection_id_fk" FOREIGN KEY ("recipeSectionId") REFERENCES public."RecipeSection"(id);

ALTER TABLE ONLY public."RecipeSection"
    ADD CONSTRAINT "RecipeSection_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES public."Recipe"(id);

ALTER TABLE ONLY public."Recipe"
    ADD CONSTRAINT "Recipe_cookbookId_Cookbook_id_fk" FOREIGN KEY ("cookbookId") REFERENCES public."Cookbook"(id);

ALTER TABLE ONLY public."Recipe"
    ADD CONSTRAINT "Recipe_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Recipe"
    ADD CONSTRAINT "Recipe_forkedFromRecipeId_Recipe_id_fk" FOREIGN KEY ("forkedFromRecipeId") REFERENCES public."Recipe"(id);

ALTER TABLE ONLY public."RunApproval"
    ADD CONSTRAINT "RunApproval_decidedByUserId_user_id_fk" FOREIGN KEY ("decidedByUserId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."RunApproval"
    ADD CONSTRAINT "RunApproval_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."RunControlEvent"
    ADD CONSTRAINT "RunControlEvent_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."RunFinding"
    ADD CONSTRAINT "RunFinding_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."RunFinding"
    ADD CONSTRAINT "RunFinding_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."RunFinding"
    ADD CONSTRAINT "RunFinding_resolvedByUserId_user_id_fk" FOREIGN KEY ("resolvedByUserId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."RunFinding"
    ADD CONSTRAINT "RunFinding_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."RunOperation"
    ADD CONSTRAINT "RunOperation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."RunPushRegistration"
    ADD CONSTRAINT "RunPushRegistration_deviceId_Device_id_fk" FOREIGN KEY ("deviceId") REFERENCES public."Device"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."RunPushRegistration"
    ADD CONSTRAINT "RunPushRegistration_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."RunStep"
    ADD CONSTRAINT "RunStep_childRunId_Run_id_fk" FOREIGN KEY ("childRunId") REFERENCES public."Run"(id) ON DELETE SET NULL;

ALTER TABLE ONLY public."RunStep"
    ADD CONSTRAINT "RunStep_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."Run"
    ADD CONSTRAINT "Run_actorUserId_user_id_fk" FOREIGN KEY ("actorUserId") REFERENCES public."user"(id);

ALTER TABLE ONLY public."Run"
    ADD CONSTRAINT "Run_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Run"
    ADD CONSTRAINT "Run_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Run"
    ADD CONSTRAINT "Run_parentRunId_Run_id_fk" FOREIGN KEY ("parentRunId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."Run"
    ADD CONSTRAINT "Run_predecessorRunId_Run_id_fk" FOREIGN KEY ("predecessorRunId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."Run"
    ADD CONSTRAINT "Run_vendorAccountId_VendorAccount_id_fk" FOREIGN KEY ("vendorAccountId") REFERENCES public."VendorAccount"(id);

ALTER TABLE ONLY public."Run"
    ADD CONSTRAINT "Run_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."SearchDocument"
    ADD CONSTRAINT "SearchDocument_entity_fk" FOREIGN KEY ("entityId", "entityKind") REFERENCES public."Entity"(id, kind);

ALTER TABLE ONLY public."SourceOrderObservation"
    ADD CONSTRAINT "SourceOrderObservation_primaryDocumentImageId_Image_id_fk" FOREIGN KEY ("primaryDocumentImageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."SourceOrderObservation"
    ADD CONSTRAINT "SourceOrderObservation_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES public."Purchase"(id);

ALTER TABLE ONLY public."SourceOrderObservation"
    ADD CONSTRAINT "SourceOrderObservation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES public."Run"(id);

ALTER TABLE ONLY public."SourceOrderObservation"
    ADD CONSTRAINT "SourceOrderObservation_screenshotImageId_Image_id_fk" FOREIGN KEY ("screenshotImageId") REFERENCES public."Image"(id);

ALTER TABLE ONLY public."SourceOrderObservation"
    ADD CONSTRAINT "SourceOrderObservation_sourceClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("sourceClaimId") REFERENCES public."ImportSourceClaim"(id);

ALTER TABLE ONLY public."SourceOrderObservation"
    ADD CONSTRAINT "SourceOrderObservation_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."SpendingCategory"
    ADD CONSTRAINT "SpendingCategory_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."SpendingCategory"
    ADD CONSTRAINT "SpendingCategory_parentId_SpendingCategory_id_fk" FOREIGN KEY ("parentId") REFERENCES public."SpendingCategory"(id);

ALTER TABLE ONLY public."StatementImportRow"
    ADD CONSTRAINT "StatementImportRow_importId_StatementImport_id_fk" FOREIGN KEY ("importId") REFERENCES public."StatementImport"(id);

ALTER TABLE ONLY public."StatementImportRow"
    ADD CONSTRAINT "StatementImportRow_statementRowId_StatementRow_id_fk" FOREIGN KEY ("statementRowId") REFERENCES public."StatementRow"(id);

ALTER TABLE ONLY public."StatementImport"
    ADD CONSTRAINT "StatementImport_source_ExternalSource_slug_fk" FOREIGN KEY (source) REFERENCES public."ExternalSource"(slug) ON UPDATE CASCADE;

ALTER TABLE ONLY public."StatementRow"
    ADD CONSTRAINT "StatementRow_accountId_FinancialAccount_id_fk" FOREIGN KEY ("accountId") REFERENCES public."FinancialAccount"(id);

ALTER TABLE ONLY public."StatementRow"
    ADD CONSTRAINT "StatementRow_batchId_StatementImport_id_fk" FOREIGN KEY ("batchId") REFERENCES public."StatementImport"(id);

ALTER TABLE ONLY public."StatementRow"
    ADD CONSTRAINT "StatementRow_source_ExternalSource_slug_fk" FOREIGN KEY (source) REFERENCES public."ExternalSource"(slug) ON UPDATE CASCADE;

ALTER TABLE ONLY public."StatementRow"
    ADD CONSTRAINT "StatementRow_supersededByRowId_StatementRow_id_fk" FOREIGN KEY ("supersededByRowId") REFERENCES public."StatementRow"(id);

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_assigneeId_LedgerParty_id_fk" FOREIGN KEY ("assigneeId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_parentTaskId_Task_id_fk" FOREIGN KEY ("parentTaskId") REFERENCES public."Task"(id);

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES public."Project"(id);

ALTER TABLE ONLY public."Task"
    ADD CONSTRAINT "Task_subjectProductId_Product_id_fk" FOREIGN KEY ("subjectProductId") REFERENCES public."Product"(id);

ALTER TABLE ONLY public."VendorAccount"
    ADD CONSTRAINT "VendorAccount_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."VendorAccount"
    ADD CONSTRAINT "VendorAccount_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES public."LedgerParty"(id);

ALTER TABLE ONLY public."VendorAccount"
    ADD CONSTRAINT "VendorAccount_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES public."Vendor"(id);

ALTER TABLE ONLY public."Vendor"
    ADD CONSTRAINT "Vendor_defaultSpendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("defaultSpendingCategoryId") REFERENCES public."SpendingCategory"(id);

ALTER TABLE ONLY public."Vendor"
    ADD CONSTRAINT "Vendor_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public."Wish"
    ADD CONSTRAINT "Wish_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES public."Entity"(id, shortcode);

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.apikey
    ADD CONSTRAINT apikey_reference_id_user_id_fk FOREIGN KEY (reference_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id);

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_refresh_id_oauth_refresh_token_id_fk FOREIGN KEY (refresh_id) REFERENCES public.oauth_refresh_token(id);

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES public.session(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id);

ALTER TABLE ONLY public.oauth_client_resource
    ADD CONSTRAINT oauth_client_resource_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.oauth_client_resource
    ADD CONSTRAINT oauth_client_resource_resource_id_oauth_resource_identifier_fk FOREIGN KEY (resource_id) REFERENCES public.oauth_resource(identifier) ON DELETE CASCADE;

ALTER TABLE ONLY public.oauth_client
    ADD CONSTRAINT oauth_client_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id);

ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id);

ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id);

ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id);

ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES public.session(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id);

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT passkey_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

-- Neon diagnostics are host-specific; local pgvector Postgres has no neon extension.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'neon') THEN
    CREATE EXTENSION IF NOT EXISTS neon;
  ELSE
    RAISE NOTICE 'Skipping neon diagnostics: extension unavailable on this host';
  END IF;
END
$$;

-- Fresh-install defaults; existing databases retain their member-selected switches.
INSERT INTO "AutomaticRule" (family, "ruleKey", revision, enabled, "enabledAt", "enabledReason", "disabledAt", "disabledReason")
VALUES
  ('field', 'field.addition', '2026-10-20.1', true, now(), 'Default confident-Addition assignment', NULL, NULL),
  ('statement_transaction', 'statement_transaction.attach', '2026-10-18.3/2026-10-17.1', false, NULL, NULL, now(), 'Starts off until member-reviewed matches show eligibility');

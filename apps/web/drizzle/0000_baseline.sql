-- The gin_trgm_ops indexes below need pg_trgm's operator classes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AiAnalysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityKind" text NOT NULL,
	"entityId" uuid,
	"feature" text NOT NULL,
	"provider" text,
	"resultSchemaRevision" integer,
	"runtime" jsonb,
	"model" text NOT NULL,
	"promptVersion" text NOT NULL,
	"inputFingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "AiAnalysis_entityKind_check" CHECK ("AiAnalysis"."entityKind" IN ('image', 'location', 'product', 'recipe', 'global')),
	CONSTRAINT "AiAnalysis_global_check" CHECK (("AiAnalysis"."entityKind" = 'global') = ("AiAnalysis"."entityId" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "AiUsage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"runId" uuid NOT NULL,
	"jobKind" text,
	"jobId" text,
	"inputTokens" integer,
	"outputTokens" integer,
	"cacheReadTokens" integer,
	"cacheWriteTokens" integer,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'succeeded' NOT NULL,
	"gatewayLogId" text,
	"estimatedCost" real,
	"durationMs" integer NOT NULL,
	"cacheStatus" text,
	"applicationCacheStatus" text,
	"entityId" uuid,
	"entityKind" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"reference_id" text NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "AppSettings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AuditLog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb,
	"userId" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"oauthClientId" text,
	"deviceId" uuid,
	"runId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "AuditLog_channel_check" CHECK ("AuditLog"."channel" IN ('web', 'api', 'mcp', 'caldav', 'system'))
);
--> statement-breakpoint
CREATE TABLE "DataException" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"check" text NOT NULL,
	"reason" text NOT NULL,
	"note" text NOT NULL,
	"fingerprint" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "EntityAttachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"imageId" uuid NOT NULL,
	"role" text DEFAULT 'attachment' NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"purpose" text,
	"documentKind" text,
	"idempotencyKey" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "EntityAttachment_role_check" CHECK ("EntityAttachment"."role" IN ('attachment', 'cover', 'logo')),
	CONSTRAINT "EntityAttachment_purpose_check" CHECK ("EntityAttachment"."purpose" IS NULL OR "EntityAttachment"."purpose" IN ('item', 'label')),
	CONSTRAINT "EntityAttachment_purpose_kind_check" CHECK ("EntityAttachment"."purpose" IS NULL OR "EntityAttachment"."entityKind" = 'product'),
	CONSTRAINT "EntityAttachment_documentKind_kind_check" CHECK ("EntityAttachment"."documentKind" IS NULL OR "EntityAttachment"."entityKind" = 'purchase')
);
--> statement-breakpoint
CREATE TABLE "EntityEmbedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"embeddingText" text NOT NULL,
	"embeddingHash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "EntityExternalId" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"externalId" text NOT NULL,
	"url" text,
	"isPrimary" boolean,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "EntityExternalId_kind_check" CHECK (("entityKind", "kind") IN (('product', 'asin'), ('product', 'retailer_sku'), ('product', 'internet_number'), ('product', 'item_number'), ('product', 'catalog_number'), ('product', 'gtin_14'), ('product', 'legacy_unspecified'), ('financialTransaction', 'settlement_ref'), ('expense', 'page'), ('task', 'page'), ('project', 'page'), ('recipe', 'page'), ('project', 'folder'))),
	CONSTRAINT "EntityExternalId_primary_check" CHECK (CASE WHEN "kind" IN ('asin', 'retailer_sku', 'internet_number', 'item_number', 'catalog_number', 'gtin_14', 'legacy_unspecified', 'page', 'folder') THEN "isPrimary" IS NOT NULL ELSE "isPrimary" IS NULL END),
	CONSTRAINT "EntityExternalId_gtin_check" CHECK ("EntityExternalId"."kind" <> 'gtin_14' OR "EntityExternalId"."externalId" ~ '^[0-9]{14}$')
);
--> statement-breakpoint
CREATE TABLE "Entity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"shortcode" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"mergedIntoId" uuid,
	CONSTRAINT "Entity_id_shortcode_key" UNIQUE("id","shortcode"),
	CONSTRAINT "Entity_id_kind_key" UNIQUE("id","kind"),
	CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant')),
	CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' ELSE false END),
	CONSTRAINT "Entity_merge_not_self_check" CHECK ("Entity"."mergedIntoId" IS NULL OR "Entity"."mergedIntoId" <> "Entity"."id"),
	CONSTRAINT "Entity_merged_is_deleted_check" CHECK ("Entity"."mergedIntoId" IS NULL OR "Entity"."deletedAt" IS NOT NULL),
	CONSTRAINT "Entity_live_has_shortcode_check" CHECK ("Entity"."deletedAt" IS NOT NULL OR "Entity"."shortcode" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "EntityLink" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"fromEntityId" uuid NOT NULL,
	"fromKind" text NOT NULL,
	"toEntityId" uuid NOT NULL,
	"toKind" text NOT NULL,
	"quantity" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "EntityLink_kind_check" CHECK (("kind", "fromKind", "toKind") IN (('wishCandidate', 'wish', 'product'), ('purchaseProduct', 'purchase', 'product'), ('projectTool', 'project', 'product'), ('gardenEntryPlanting', 'gardenEntry', 'planting'), ('productComponent', 'product', 'product'), ('taskDependency', 'task', 'task'), ('projectDependency', 'project', 'project'))),
	CONSTRAINT "EntityLink_quantity_check" CHECK (CASE WHEN "kind" IN ('productComponent') THEN "quantity" IS NOT NULL AND "quantity" >= 1 ELSE "quantity" IS NULL END),
	CONSTRAINT "EntityLink_no_self_check" CHECK ("kind" NOT IN ('productComponent', 'taskDependency', 'projectDependency') OR "fromEntityId" <> "toEntityId")
);
--> statement-breakpoint
CREATE TABLE "ExpenseAttribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expenseId" uuid NOT NULL,
	"role" text NOT NULL,
	"ledgerPartyId" uuid,
	"weight" bigint NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "ExpenseAttribution_role_check" CHECK ("ExpenseAttribution"."role" IN ('beneficiary', 'funder')),
	CONSTRAINT "ExpenseAttribution_weight_check" CHECK ("ExpenseAttribution"."weight" > 0 AND "ExpenseAttribution"."weight" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "ExternalSource" (
	"slug" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"vendorId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ExternalSource_slug_check" CHECK ("ExternalSource"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "FinancialTransactionAllocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transactionId" uuid NOT NULL,
	"purchaseId" uuid NOT NULL,
	"amount" double precision NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "FinancialTransactionAllocation_amount_whole_cent_check" CHECK ("FinancialTransactionAllocation"."amount" <> 0 AND abs("FinancialTransactionAllocation"."amount" * 100 - round("FinancialTransactionAllocation"."amount" * 100)) < 0.0000001)
);
--> statement-breakpoint
CREATE TABLE "ImageDerivative" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imageId" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"key" text NOT NULL,
	"sourceContentHash" text NOT NULL,
	"processorRevision" integer NOT NULL,
	"contentType" text,
	"sha256" text,
	"width" integer,
	"height" integer,
	"failureReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "ImageDerivative_purpose_check" CHECK ("ImageDerivative"."purpose" IN ('transparent')),
	CONSTRAINT "ImageDerivative_status_check" CHECK ("ImageDerivative"."status" IN ('pending', 'ready', 'skipped', 'failed', 'abandoned')),
	CONSTRAINT "ImageDerivative_ready_metadata_check" CHECK ("ImageDerivative"."status" <> 'ready' OR ("ImageDerivative"."contentType" IS NOT NULL AND "ImageDerivative"."contentType" = 'image/png' AND "ImageDerivative"."sha256" IS NOT NULL AND "ImageDerivative"."width" IS NOT NULL AND "ImageDerivative"."width" > 0 AND "ImageDerivative"."height" IS NOT NULL AND "ImageDerivative"."height" > 0))
);
--> statement-breakpoint
CREATE TABLE "ImageDescriptionCorrection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imageId" uuid NOT NULL,
	"description" text NOT NULL,
	"confirmedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "ImageProcessingAttempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"jobId" uuid NOT NULL,
	"number" integer NOT NULL,
	"submissionId" uuid,
	"inputKey" text,
	"state" text NOT NULL,
	"executor" jsonb,
	"assignedUserId" text,
	"assignedConnectionId" text,
	"diagnostics" jsonb,
	"result" jsonb,
	"error" text,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	CONSTRAINT "ImageProcessingAttempt_number_check" CHECK ("ImageProcessingAttempt"."number" > 0),
	CONSTRAINT "ImageProcessingAttempt_state_check" CHECK ("ImageProcessingAttempt"."state" IN ('leased','running','waiting','expired','ready','skipped','failed'))
);
--> statement-breakpoint
CREATE TABLE "ImageProcessingEvent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jobId" uuid NOT NULL,
	"eventKey" text NOT NULL,
	"attempt" integer,
	"event" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"source" text DEFAULT 'server' NOT NULL,
	"details" jsonb,
	"occurredAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ImageProcessingJob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publicId" text DEFAULT 'IPR-' || upper(replace(gen_random_uuid()::text, '-', '')) NOT NULL,
	"imageId" uuid NOT NULL,
	"derivativeId" uuid,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"sourceContentHash" text NOT NULL,
	"processorRevision" integer NOT NULL,
	"submissionId" uuid,
	"runId" uuid,
	"attemptId" uuid,
	"leaseExpiresAt" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp DEFAULT now() NOT NULL,
	"dispatchedAt" timestamp,
	"completedAt" timestamp,
	"lastError" text,
	"runtime" jsonb,
	"result" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ImageProcessingJob_kind_check" CHECK ("ImageProcessingJob"."kind" IN ('subject_lift', 'describe_image')),
	CONSTRAINT "ImageProcessingJob_state_check" CHECK ("ImageProcessingJob"."state" IN ('pending', 'waiting_for_device', 'leased', 'ready', 'skipped', 'failed')),
	CONSTRAINT "ImageProcessingJob_attempts_check" CHECK ("ImageProcessingJob"."attempts" >= 0),
	CONSTRAINT "ImageProcessingJob_lease_check" CHECK (("ImageProcessingJob"."state" = 'leased') = ("ImageProcessingJob"."attemptId" IS NOT NULL AND "ImageProcessingJob"."leaseExpiresAt" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ImageProcessingOrphan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"attemptId" uuid,
	"reason" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ImageProcessingSubmission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publicId" text DEFAULT 'IPS-' || upper(replace(gen_random_uuid()::text, '-', '')) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ImageProcessingSubmissionJob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submissionId" uuid NOT NULL,
	"jobId" uuid NOT NULL,
	"disposition" text NOT NULL,
	"baselineAttempts" integer NOT NULL,
	CONSTRAINT "ImageProcessingSubmissionJob_disposition_check" CHECK ("ImageProcessingSubmissionJob"."disposition" IN ('new','reused','running','retry')),
	CONSTRAINT "ImageProcessingSubmissionJob_baseline_check" CHECK ("ImageProcessingSubmissionJob"."baselineAttempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ImageSighting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
	"capturedAt" timestamp,
	"capturedAtOffsetMinutes" integer,
	"addedAt" timestamp,
	"location" jsonb,
	"placeName" text,
	"camera" jsonb,
	"matchKind" text NOT NULL,
	"hashDistance" integer,
	"aspectGate" boolean,
	"observedAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "ImageSighting_sourceType_check" CHECK ("ImageSighting"."sourceType" IN ('userLibrary', 'cloudShared', 'iTunesSynced')),
	CONSTRAINT "ImageSighting_matchKind_check" CHECK ("ImageSighting"."matchKind" IN ('import', 'libraryMatch'))
);
--> statement-breakpoint
CREATE TABLE "ImportHunt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"financialTransactionId" uuid NOT NULL,
	"vendorId" uuid,
	"vendorAccountId" uuid,
	"state" text DEFAULT 'pending_mail' NOT NULL,
	"dateFrom" date NOT NULL,
	"dateTo" date NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"matchedOrderIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"receiptImageId" uuid,
	"receiptRunId" uuid,
	"receiptQueuedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ImportPreparedLine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preparedOrderId" uuid NOT NULL,
	"stableLineId" text NOT NULL,
	"position" integer NOT NULL,
	"line" jsonb NOT NULL,
	"identifiers" jsonb NOT NULL,
	"candidates" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ImportPreparedOrder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"prepareOperationId" text NOT NULL,
	"itemOperationId" text NOT NULL,
	"stableOrderId" text NOT NULL,
	"sourceKind" text NOT NULL,
	"sourceExternalKey" text NOT NULL,
	"sourceChecksum" text NOT NULL,
	"evidenceChecksum" text NOT NULL,
	"extractionRevision" text NOT NULL,
	"extraction" jsonb NOT NULL,
	"primaryDocumentImageId" uuid,
	"screenshotImageId" uuid,
	"targetFingerprint" text NOT NULL,
	"evidenceFingerprint" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ImportPreparedOrder_source_kind_check" CHECK ("ImportPreparedOrder"."sourceKind" IN ('browser_order', 'mail_message', 'mail_attachment', 'receipt_photo', 'vendor_export'))
);
--> statement-breakpoint
CREATE TABLE "ImportSourceClaim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"vendorAccountId" uuid,
	"kind" text NOT NULL,
	"externalKey" text NOT NULL,
	"checksum" text NOT NULL,
	"purchaseId" uuid,
	"firstRunId" uuid NOT NULL,
	"lastRunId" uuid NOT NULL,
	"outputFingerprint" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ImportSourceClaim_kind_check" CHECK ("ImportSourceClaim"."kind" IN ('browser_order', 'mail_message', 'mail_attachment', 'receipt_photo', 'vendor_export'))
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "LedgerSourceClaim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expenseId" uuid,
	"ledgerTransferId" uuid,
	"source" text NOT NULL,
	"sourceKey" text NOT NULL,
	"sourceKeyVersion" integer NOT NULL,
	"normalizedEvidence" jsonb NOT NULL,
	"targetAmountAtClaim" double precision NOT NULL,
	"reconciliationDecision" text NOT NULL,
	"reconciliationNote" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "LedgerSourceClaim_owner_check" CHECK (("LedgerSourceClaim"."expenseId" IS NOT NULL) <> ("LedgerSourceClaim"."ledgerTransferId" IS NOT NULL)),
	CONSTRAINT "LedgerSourceClaim_sourceKeyVersion_check" CHECK ("LedgerSourceClaim"."sourceKeyVersion" > 0),
	CONSTRAINT "LedgerSourceClaim_source_check" CHECK ("LedgerSourceClaim"."source" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "LedgerSourceClaim"."source" = lower(trim("LedgerSourceClaim"."source"))),
	CONSTRAINT "LedgerSourceClaim_reconciliation_check" CHECK (abs("LedgerSourceClaim"."targetAmountAtClaim" * 100 - round("LedgerSourceClaim"."targetAmountAtClaim" * 100)) < 0.0000001
          AND abs((("LedgerSourceClaim"."normalizedEvidence"->>'amount')::double precision) * 100 - round((("LedgerSourceClaim"."normalizedEvidence"->>'amount')::double precision) * 100)) < 0.0000001
          AND (("LedgerSourceClaim"."reconciliationDecision" = 'amounts_match'
            AND "LedgerSourceClaim"."reconciliationNote" IS NULL
            AND abs((("LedgerSourceClaim"."normalizedEvidence"->>'amount')::double precision) - "LedgerSourceClaim"."targetAmountAtClaim") < 0.0000001)
          OR ("LedgerSourceClaim"."reconciliationDecision" = 'accept_target_amount'
            AND length(trim("LedgerSourceClaim"."reconciliationNote")) > 0
            AND abs((("LedgerSourceClaim"."normalizedEvidence"->>'amount')::double precision) - "LedgerSourceClaim"."targetAmountAtClaim") >= 0.0000001)))
);
--> statement-breakpoint
CREATE TABLE "MailboxCursor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"historyId" text,
	"lastPolledAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "McpToolCall" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"toolName" text NOT NULL,
	"outcome" text NOT NULL,
	"registeredAtCall" boolean NOT NULL,
	"surface" text NOT NULL,
	"entityKind" text,
	"release" text NOT NULL,
	"occurredAt" timestamp NOT NULL,
	"ingestedAt" timestamp DEFAULT now() NOT NULL,
	"userId" text NOT NULL,
	"clientId" text
);
--> statement-breakpoint
CREATE TABLE "MealFoodEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mealId" uuid NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"sourceKind" text NOT NULL,
	"ingredientId" uuid,
	"productId" uuid,
	"amountValue" double precision,
	"amountUnit" text,
	"name" text,
	"nutrients" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "MealFoodEntry_amount_check" CHECK (
  ("MealFoodEntry"."amountValue" IS NULL AND "MealFoodEntry"."amountUnit" IS NULL) OR (
    "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."amountUnit" IS NOT NULL
    AND "MealFoodEntry"."amountValue" > 0 AND "MealFoodEntry"."amountValue" < 'Infinity'::double precision
    AND length(trim("MealFoodEntry"."amountUnit")) > 0 AND "MealFoodEntry"."amountUnit" = trim("MealFoodEntry"."amountUnit")
  )
),
	CONSTRAINT "MealFoodEntry_source_check" CHECK (("MealFoodEntry"."sourceKind" = 'ingredient' AND "MealFoodEntry"."ingredientId" IS NOT NULL AND "MealFoodEntry"."productId" IS NULL AND "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."name" IS NULL AND "MealFoodEntry"."nutrients" IS NULL) OR ("MealFoodEntry"."sourceKind" = 'product' AND "MealFoodEntry"."ingredientId" IS NULL AND "MealFoodEntry"."productId" IS NOT NULL AND "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."name" IS NULL AND "MealFoodEntry"."nutrients" IS NULL) OR ("MealFoodEntry"."sourceKind" = 'manual' AND "MealFoodEntry"."ingredientId" IS NULL AND "MealFoodEntry"."productId" IS NULL AND length(trim("MealFoodEntry"."name")) > 0 AND "MealFoodEntry"."name" IS NOT NULL AND "MealFoodEntry"."nutrients" IS NOT NULL AND jsonb_typeof("MealFoodEntry"."nutrients") = 'object' AND "MealFoodEntry"."nutrients" <> '{}'::jsonb))
);
--> statement-breakpoint
CREATE TABLE "MealRecipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mealId" uuid NOT NULL,
	"recipeId" uuid NOT NULL,
	"scale" real DEFAULT 1 NOT NULL,
	"sortOrder" integer,
	"estimatedYieldGrams" integer,
	"actualYieldGrams" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "MealRecipe_estimatedYieldGrams_check" CHECK ("MealRecipe"."estimatedYieldGrams" IS NULL OR "MealRecipe"."estimatedYieldGrams" > 0),
	CONSTRAINT "MealRecipe_actualYieldGrams_check" CHECK ("MealRecipe"."actualYieldGrams" IS NULL OR "MealRecipe"."actualYieldGrams" > 0)
);
--> statement-breakpoint
CREATE TABLE "MealRecipePortion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mealRecipeId" uuid NOT NULL,
	"mealId" uuid NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"amountValue" double precision NOT NULL,
	"amountUnit" text NOT NULL,
	"confirmedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "MealRecipePortion_amount_check" CHECK (
  ("MealRecipePortion"."amountValue" IS NULL AND "MealRecipePortion"."amountUnit" IS NULL) OR (
    "MealRecipePortion"."amountValue" IS NOT NULL AND "MealRecipePortion"."amountUnit" IS NOT NULL
    AND "MealRecipePortion"."amountValue" > 0 AND "MealRecipePortion"."amountValue" < 'Infinity'::double precision
    AND length(trim("MealRecipePortion"."amountUnit")) > 0 AND "MealRecipePortion"."amountUnit" = trim("MealRecipePortion"."amountUnit")
  )
)
);
--> statement-breakpoint
CREATE TABLE "MerchantVendorRule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"normalizedMerchant" text NOT NULL,
	"vendorId" uuid NOT NULL,
	"confirmedByUserId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp,
	"created_at" timestamp,
	"revoked" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}',
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"grant_types" text[],
	"response_types" text[],
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"public" boolean,
	"type" text,
	"require_pkce" boolean,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp,
	"created_at" timestamp,
	"revoked" timestamp,
	"rotated_at" timestamp,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp,
	"auth_time" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "OrderMail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"vendorId" uuid,
	"messageId" text NOT NULL,
	"threadId" text,
	"historyId" text,
	"sender" text NOT NULL,
	"subject" text NOT NULL,
	"receivedAt" timestamp NOT NULL,
	"rawChecksum" text NOT NULL,
	"classifiedChecksum" text,
	"content" jsonb DEFAULT '{"snippet":null,"bodyText":null,"bodyHtml":null}'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OrderMailAttachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orderMailId" uuid NOT NULL,
	"providerAttachmentId" text NOT NULL,
	"filename" text NOT NULL,
	"mimeType" text NOT NULL,
	"checksum" text NOT NULL,
	"pendingObjectKey" text,
	"imageId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OrderMailCandidateDecision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eventId" uuid NOT NULL,
	"purchaseId" uuid NOT NULL,
	"decision" text NOT NULL,
	"evidenceChecksum" text NOT NULL,
	"decidedByUserId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "OrderMailCandidateDecision_decision_check" CHECK ("OrderMailCandidateDecision"."decision" IN ('linked', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "OrderMailEvent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orderMailId" uuid NOT NULL,
	"event" text NOT NULL,
	"orderId" text,
	"amount" double precision,
	"currency" text,
	"occurredAt" timestamp,
	"sourceKey" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"supersededAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp DEFAULT now(),
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "PhotoGroupProposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"groupKey" text NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skip" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"productKind" text NOT NULL,
	"productId" uuid,
	"productCreate" jsonb,
	"productCreateCategoryId" uuid,
	"inventoryLocationId" uuid,
	"inventory" jsonb,
	"inventoryOwnerPartyId" uuid,
	"evidence" text,
	"conflictProductIds" jsonb,
	"lastError" text,
	"committedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "PhotoGroupProposal_state_check" CHECK ("PhotoGroupProposal"."state" IN ('proposed', 'committed', 'discarded')),
	CONSTRAINT "PhotoGroupProposal_product_kind_check" CHECK ("PhotoGroupProposal"."productKind" IN ('existing', 'create'))
);
--> statement-breakpoint
CREATE TABLE "ProductConversionCoverage" (
	"productId" uuid PRIMARY KEY NOT NULL,
	"coverageTier" text NOT NULL,
	"coveredKinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"applicableKinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"islandCount" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"engineVersion" text NOT NULL,
	"computedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ProductMatchCandidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"productAId" uuid NOT NULL,
	"productBId" uuid NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"evidence" text,
	"sourceUrls" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ProductMatchCandidate_canonical_pair_check" CHECK ("ProductMatchCandidate"."productAId" < "ProductMatchCandidate"."productBId"),
	CONSTRAINT "ProductMatchCandidate_source_check" CHECK ("ProductMatchCandidate"."source" IN ('agent', 'detector')),
	CONSTRAINT "ProductMatchCandidate_state_check" CHECK ("ProductMatchCandidate"."state" IN ('open', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "ProductUnitMapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"productId" uuid NOT NULL,
	"aValue" double precision NOT NULL,
	"aUnit" text NOT NULL,
	"bValue" double precision NOT NULL,
	"bUnit" text NOT NULL,
	"source" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "PurchasePaymentEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchaseId" uuid NOT NULL,
	"sourceClaimId" uuid NOT NULL,
	"amount" double precision NOT NULL,
	"chargedAt" timestamp,
	"cardLastFour" text,
	"description" text,
	"evidenceIndex" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RecipeSection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipeId" uuid NOT NULL,
	"name" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sortOrder" integer
);
--> statement-breakpoint
CREATE TABLE "RecipeSectionIngredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipeSectionId" uuid NOT NULL,
	"ingredientId" uuid NOT NULL,
	"amounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rawLine" text,
	"modifier" text,
	"sortOrder" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "RunApproval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"operationId" text NOT NULL,
	"operationKind" text NOT NULL,
	"args" jsonb NOT NULL,
	"argsFingerprint" text NOT NULL,
	"targetFingerprint" text NOT NULL,
	"evidenceFingerprint" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"decidedByUserId" text,
	"decidedAt" timestamp,
	"rejectedAt" timestamp,
	"consumedAt" timestamp,
	"invalidatedAt" timestamp,
	CONSTRAINT "RunApproval_state_check" CHECK ("RunApproval"."state" IN ('pending', 'granted', 'rejected', 'consumed', 'invalidated'))
);
--> statement-breakpoint
CREATE TABLE "RunControlEvent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"action" text NOT NULL,
	"controllerUserId" text NOT NULL,
	"controllerName" text NOT NULL,
	"controllerEmail" text NOT NULL,
	"controllerLedgerPartyId" uuid NOT NULL,
	"controllerLedgerPartyShortcode" text NOT NULL,
	"controllerLedgerPartyName" text NOT NULL,
	"controllerLedgerPartyKind" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunControlEvent_action_check" CHECK ("RunControlEvent"."action" IN ('prompt', 'abort', 'pause', 'resume', 'cancel', 'approve', 'reject', 'retry', 'retry_dispatch', 'upload_evidence', 'no_evidence_available', 'escalate_sol'))
);
--> statement-breakpoint
CREATE TABLE "RunEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"targetId" uuid NOT NULL,
	"kind" text NOT NULL,
	"objectKey" text NOT NULL,
	"checksum" text NOT NULL,
	"mediaType" text NOT NULL,
	"byteSize" integer,
	"sourceMetadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunEvidence_kind_check" CHECK ("RunEvidence"."kind" IN ('browser_capture', 'gmail_attachment', 'manual_upload'))
);
--> statement-breakpoint
CREATE TABLE "RunFinding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid,
	"ledgerPartyId" uuid NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"proposedFix" jsonb,
	"evidenceFingerprint" text NOT NULL,
	"autoApplied" boolean DEFAULT false NOT NULL,
	"probability" real,
	"status" text DEFAULT 'open' NOT NULL,
	"resolvedAt" timestamp,
	"expiresAt" timestamp,
	"resolvedByUserId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunFinding_status_check" CHECK ("RunFinding"."status" IN ('open', 'applied', 'dismissed')),
	CONSTRAINT "RunFinding_entityKind_check" CHECK ("RunFinding"."entityKind" IN ('purchase', 'expense', 'product', 'run'))
);
--> statement-breakpoint
CREATE TABLE "RunOperation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"executor" jsonb,
	"runId" uuid NOT NULL,
	"operationId" text NOT NULL,
	"kind" text NOT NULL,
	"inputFingerprint" text NOT NULL,
	"state" text DEFAULT 'started' NOT NULL,
	"result" jsonb,
	"error" text,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunOperation_state_check" CHECK ("RunOperation"."state" IN ('started', 'paused_approval', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "RunOrderCandidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"orderId" text NOT NULL,
	"orderUrl" text,
	"orderedAt" date,
	"state" text DEFAULT 'pending' NOT NULL,
	"listedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunOrderCandidate_state_check" CHECK ("RunOrderCandidate"."state" IN ('pending', 'covered', 'imported', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "RunProgress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"eventId" text NOT NULL,
	"phase" text NOT NULL,
	"currentItem" text,
	"awaitingApproval" boolean DEFAULT false NOT NULL,
	"detail" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RunTarget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"position" integer,
	"vendorAccountId" uuid,
	"sourceKind" text,
	"sourceExternalKey" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"targetFingerprint" text NOT NULL,
	"evidenceFingerprint" text,
	"outcome" text,
	"warning" text,
	"diff" jsonb,
	"preparedAt" timestamp,
	"completedAt" timestamp,
	"deviceWorkState" text,
	"deviceWorkAttempts" integer DEFAULT 0 NOT NULL,
	"deviceWorkError" text,
	"deviceWorkDeviceId" uuid,
	"deviceWorkUpdatedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunTarget_entityKind_check" CHECK ("RunTarget"."entityKind" IN ('purchase', 'product', 'image')),
	CONSTRAINT "RunTarget_state_check" CHECK ("RunTarget"."state" IN ('pending', 'prepared', 'completed', 'skipped', 'unresolved', 'needs_evidence', 'unavailable')),
	CONSTRAINT "RunTarget_outcome_check" CHECK ("RunTarget"."outcome" IS NULL OR "RunTarget"."outcome" IN ('replayed', 'raw_evidence_drift', 'semantic_drift', 'enriched', 'unavailable', 'skipped', 'attached')),
	CONSTRAINT "RunTarget_deviceWorkState_check" CHECK ("RunTarget"."deviceWorkState" IS NULL OR "RunTarget"."deviceWorkState" IN ('queued', 'running', 'paused', 'failed', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "SearchDocument" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"typeHint" text,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"keywords" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"body" text NOT NULL,
	"semanticText" text NOT NULL,
	"normalizedText" text NOT NULL,
	"searchVector" "tsvector" NOT NULL,
	"sourceHash" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "StatementImport" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"label" text NOT NULL,
	"fingerprint" text NOT NULL,
	"dateKind" text DEFAULT 'unknown' NOT NULL,
	"rowCountDeclared" integer,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "StatementImport_source_slug_check" CHECK ("StatementImport"."source" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "StatementImport"."source" = lower(trim("StatementImport"."source"))),
	CONSTRAINT "StatementImport_dateKind_check" CHECK ("StatementImport"."dateKind" IN ('posted', 'transaction', 'unknown')),
	CONSTRAINT "StatementImport_rowCountDeclared_check" CHECK ("StatementImport"."rowCountDeclared" IS NULL OR "StatementImport"."rowCountDeclared" >= 0)
);
--> statement-breakpoint
CREATE TABLE "StatementRow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batchId" uuid NOT NULL,
	"source" text NOT NULL,
	"externalId" text NOT NULL,
	"accountDescriptor" text NOT NULL,
	"statementDate" date NOT NULL,
	"amount" double precision NOT NULL,
	"providerAmount" double precision NOT NULL,
	"merchant" text,
	"rawDescription" text NOT NULL,
	"sourceCategory" text,
	"providerStatus" text,
	"providerNotes" text,
	"accountId" uuid,
	"disposition" text DEFAULT 'open' NOT NULL,
	"dispositionReason" text,
	"dispositionNote" text,
	"supersededByRowId" uuid,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "StatementRow_source_slug_check" CHECK ("StatementRow"."source" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "StatementRow"."source" = lower(trim("StatementRow"."source"))),
	CONSTRAINT "StatementRow_amount_whole_cent_check" CHECK ("StatementRow"."amount" <> 0 AND abs("StatementRow"."amount" * 100 - round("StatementRow"."amount" * 100)) < 0.0000001),
	CONSTRAINT "StatementRow_providerAmount_whole_cent_check" CHECK ("StatementRow"."providerAmount" <> 0 AND abs("StatementRow"."providerAmount" * 100 - round("StatementRow"."providerAmount" * 100)) < 0.0000001),
	CONSTRAINT "StatementRow_providerStatus_check" CHECK ("StatementRow"."providerStatus" IS NULL OR "StatementRow"."providerStatus" IN ('posted', 'pending')),
	CONSTRAINT "StatementRow_disposition_check" CHECK (("StatementRow"."disposition" = 'open' AND "StatementRow"."dispositionReason" IS NULL AND "StatementRow"."dispositionNote" IS NULL)
          OR ("StatementRow"."disposition" = 'ignored' AND "StatementRow"."dispositionReason" IS NOT NULL AND "StatementRow"."dispositionNote" IS NOT NULL)),
	CONSTRAINT "StatementRow_dispositionReason_check" CHECK ("StatementRow"."dispositionReason" IS NULL OR "StatementRow"."dispositionReason" IN
          ('not_modeled', 'not_a_purchase', 'duplicate_of_other_source', 'pre_cubby', 'other')),
	CONSTRAINT "StatementRow_externalId_format_check" CHECK ("StatementRow"."externalId" ~ '^v1:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "SuggestionDismissal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"suggestionKind" text NOT NULL,
	"candidateKey" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "UpcLookupCache" (
	"upc" text PRIMARY KEY NOT NULL,
	"manufacturer" text,
	"brand" text,
	"priceDollars" double precision,
	"imageUrl" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"fetchedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Cookbook" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"author" text[] DEFAULT '{}'::text[] NOT NULL,
	"subjects" text[] DEFAULT '{}'::text[] NOT NULL,
	"sourceLabel" text NOT NULL,
	"rawJson" jsonb NOT NULL,
	"report" jsonb,
	"productId" uuid,
	"importedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"installationId" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"appVersion" text,
	"osVersion" text,
	"lastSeenAt" timestamp,
	"automaticWork" boolean DEFAULT true NOT NULL,
	"remotePaused" boolean DEFAULT false NOT NULL,
	"ledgerPartyId" uuid,
	"productId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "Device_platform_check" CHECK ("Device"."platform" IN ('ios', 'macos'))
);
--> statement-breakpoint
CREATE TABLE "Expense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"cost" double precision,
	"date" date,
	"lineKind" text DEFAULT 'principal' NOT NULL,
	"lineBasis" text DEFAULT 'item_line' NOT NULL,
	"costType" text NOT NULL,
	"trade" text,
	"url" text,
	"notes" text,
	"future" boolean DEFAULT false NOT NULL,
	"projectId" uuid,
	"productId" uuid,
	"productQuantity" double precision,
	"purchaseId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "Expense_date_cost_check" CHECK ("Expense"."date" IS NOT NULL OR ("Expense"."cost" IS NOT NULL AND "Expense"."cost" = 0)),
	CONSTRAINT "Expense_live_charge_assignment_check" CHECK ("Expense"."deletedAt" IS NOT NULL OR "Expense"."lineKind" = 'principal' OR ("Expense"."projectId" IS NULL AND "Expense"."purchaseId" IS NOT NULL)),
	CONSTRAINT "Expense_cost_whole_cent_check" CHECK ("Expense"."cost" IS NULL OR abs("Expense"."cost" * 100 - round("Expense"."cost" * 100)) < 0.0000001),
	CONSTRAINT "Expense_productQuantity_check" CHECK ("Expense"."productQuantity" IS NULL OR ("Expense"."productId" IS NOT NULL AND ("Expense"."productQuantity" <> 0 OR ("Expense"."cost" IS NOT NULL AND "Expense"."cost" < 0)))),
	CONSTRAINT "Expense_lineKind_productId_check" CHECK ("Expense"."lineKind" = 'principal' OR "Expense"."productId" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "FinancialAccount" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"identity" jsonb NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"sourceAliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cardNumbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"providerVendorId" uuid,
	"ledgerPartyId" uuid,
	"inventoryOwnerDefaultEnabled" boolean DEFAULT false NOT NULL,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "FinancialAccount_providerVendor_stored_value_check" CHECK ("FinancialAccount"."providerVendorId" IS NULL OR "FinancialAccount"."identity"->>'kind' = 'stored_value')
);
--> statement-breakpoint
CREATE TABLE "FinancialTransaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"accountId" uuid NOT NULL,
	"ledgerTransferId" uuid,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"amount" double precision NOT NULL,
	"transactionDate" date,
	"postedDate" date,
	"merchant" text,
	"rawDescription" text,
	"sourceCategory" text,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "FinancialTransaction_amount_whole_cent_check" CHECK ("FinancialTransaction"."amount" <> 0 AND abs("FinancialTransaction"."amount" * 100 - round("FinancialTransaction"."amount" * 100)) < 0.0000001),
	CONSTRAINT "FinancialTransaction_posted_date_check" CHECK ("FinancialTransaction"."status" <> 'posted' OR "FinancialTransaction"."postedDate" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "GardenEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"locationId" uuid NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"observedOn" date NOT NULL,
	"notes" text,
	"harvestAmount" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"key" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"contentType" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"width" integer,
	"height" integer,
	"perceptualHash" text,
	"sourceFingerprint" jsonb,
	"detectedContentType" text,
	"sha256" text,
	"renderStatus" text,
	"storageStatus" text,
	"source" text DEFAULT 'unknown' NOT NULL,
	"sourcePageUrl" text,
	"sourceAssetUrl" text,
	"sourceName" text,
	"useOriginal" boolean DEFAULT false NOT NULL,
	"verifiedAt" timestamp,
	"capturedAt" timestamp,
	"capturedAtOffsetMinutes" integer,
	"captureLocation" jsonb,
	"capturePlaceName" text,
	"captureDeviceLabel" text,
	"capturedByPartyId" uuid,
	"captureAttribution" text DEFAULT 'none' NOT NULL,
	"provenanceEvidence" jsonb,
	"metadataRevision" integer,
	"embeddedMetadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "Image_status_check" CHECK ("Image"."status" IN ('PENDING', 'UPLOADED', 'FAILED')),
	CONSTRAINT "Image_renderStatus_check" CHECK ("Image"."renderStatus" IN ('unverified', 'verified', 'failed')),
	CONSTRAINT "Image_storageStatus_check" CHECK ("Image"."storageStatus" IN ('unverified', 'available', 'missing', 'metadata_mismatch')),
	CONSTRAINT "Image_perceptualHash_format_check" CHECK ("Image"."perceptualHash" IS NULL OR "Image"."perceptualHash" ~ '^[0-9a-f]{16}$')
);
--> statement-breakpoint
CREATE TABLE "Ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"naKinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"usuallyOnHand" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"recipeId" uuid
);
--> statement-breakpoint
CREATE TABLE "InventoryEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"productId" uuid NOT NULL,
	"amountValue" double precision NOT NULL,
	"amountUnit" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"locationId" uuid NOT NULL,
	"verifiedAt" timestamp,
	"placement" text DEFAULT 'stock' NOT NULL,
	"ownershipMode" text DEFAULT 'inherit' NOT NULL,
	"ownerLedgerPartyId" uuid,
	CONSTRAINT "InventoryEntry_placement_check" CHECK ("InventoryEntry"."placement" IN ('stock', 'installed')),
	CONSTRAINT "InventoryEntry_ownership_valid" CHECK (("InventoryEntry"."ownershipMode" = 'person' AND "InventoryEntry"."ownerLedgerPartyId" IS NOT NULL) OR ("InventoryEntry"."ownershipMode" IN ('inherit', 'unassigned') AND "InventoryEntry"."ownerLedgerPartyId" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "LedgerParty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"userId" text,
	CONSTRAINT "LedgerParty_kind_check" CHECK ("LedgerParty"."kind" IN ('member', 'guest', 'household')),
	CONSTRAINT "LedgerParty_user_member_check" CHECK ("LedgerParty"."userId" IS NULL OR "LedgerParty"."kind" = 'member')
);
--> statement-breakpoint
CREATE TABLE "LedgerTransfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"fromPartyId" uuid NOT NULL,
	"toPartyId" uuid NOT NULL,
	"amount" double precision NOT NULL,
	"date" date NOT NULL,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "LedgerTransfer_amount_whole_cent_check" CHECK ("LedgerTransfer"."amount" > 0 AND abs("LedgerTransfer"."amount" * 100 - round("LedgerTransfer"."amount" * 100)) < 0.0000001)
);
--> statement-breakpoint
CREATE TABLE "Location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"lastBulkInventory" timestamp,
	"parentId" uuid,
	"productId" uuid,
	"type" text NOT NULL,
	"notes" text,
	CONSTRAINT "Location_furniture_product_check" CHECK ("Location"."type" <> 'furniture' OR "Location"."productId" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "Meal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"date" date NOT NULL,
	"name" text,
	"sortOrder" integer,
	"mealType" text,
	"mealKind" text DEFAULT 'cooked' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Plant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"gardenGuideKey" text,
	"verdict" text,
	"ingredientId" uuid,
	"latinName" text,
	"breeding" text,
	"daysFromSowMin" integer,
	"daysFromSowMax" integer,
	"daysFromTransplantMin" integer,
	"daysFromTransplantMax" integer,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Planting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"plantId" uuid NOT NULL,
	"outcome" text,
	"sourceProductId" uuid,
	"locationId" uuid,
	"taskId" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"quantity" text,
	"notes" text,
	"plannedWindow" text,
	"sowedOn" date,
	"transplantedOn" date,
	"finishedOn" date,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"manufacturer" text NOT NULL,
	"fdc_id" integer,
	"model" text,
	"expectedQuantity" integer,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"ingredientId" uuid,
	"growsPlantId" uuid,
	"categoryId" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"price" real,
	"usdaUnavailable" boolean,
	"stockTracked" boolean,
	"labelNutrition" jsonb
);
--> statement-breakpoint
CREATE TABLE "ProductCategory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"parentId" uuid,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"feature" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "ProductCategory_sortOrder_check" CHECK ("ProductCategory"."sortOrder" >= 0),
	CONSTRAINT "ProductCategory_feature_check" CHECK ("ProductCategory"."feature" IS NULL OR "ProductCategory"."feature" IN ('food', 'books', 'tools', 'tool-consumables', 'tool-accessories', 'storage', 'hardware', 'electronics', 'software', 'household', 'supplies', 'apparel'))
);
--> statement-breakpoint
CREATE TABLE "Project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"kind" text,
	"locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"locationsMode" text DEFAULT 'inherit' NOT NULL,
	"defaultTrade" text,
	"costEstimate" double precision,
	"parentProjectId" uuid,
	"startDate" date,
	"endDate" date,
	"icon" text,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Purchase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"vendorId" uuid NOT NULL,
	"vendorAccountId" uuid,
	"defaultProjectId" uuid,
	"defaultTrade" text,
	"orderId" text,
	"displayLabel" text,
	"date" date NOT NULL,
	"statedTotal" double precision,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"runId" uuid,
	CONSTRAINT "Purchase_statedTotal_whole_cent_check" CHECK ("Purchase"."statedTotal" IS NULL OR abs("Purchase"."statedTotal" * 100 - round("Purchase"."statedTotal" * 100)) < 0.0000001)
);
--> statement-breakpoint
CREATE TABLE "Recipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"sourceType" text,
	"sourceUrl" text,
	"sourceLabel" text,
	"cookbookId" uuid,
	"forkedFromRecipeId" uuid,
	"yield" jsonb,
	"servings" integer,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"totals" jsonb,
	"totalsComputedAt" timestamp,
	"activeMinutes" integer,
	"totalMinutes" integer,
	"meta" jsonb,
	CONSTRAINT "Recipe_sourceType_check" CHECK ("sourceType" IS NULL OR "sourceType" IN ('Book', 'Website', 'Other', 'Notion'))
);
--> statement-breakpoint
CREATE TABLE "Run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"ledgerPartyId" uuid,
	"actorName" text NOT NULL,
	"vendorAccountId" uuid,
	"vendorId" uuid,
	"purpose" text DEFAULT 'account_sync' NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"coordinatorModel" text DEFAULT 'gpt-6-sol' NOT NULL,
	"skillRevision" text DEFAULT 'purchase-import@1' NOT NULL,
	"runtimeRevision" text DEFAULT 'flue@1' NOT NULL,
	"decisionRevision" integer DEFAULT 1 NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"endedAt" timestamp,
	"ordersSeen" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"auditedAt" timestamp,
	"failureCode" text,
	"notes" text,
	"dispatchAttempts" integer DEFAULT 0 NOT NULL,
	"dispatchError" text,
	"coordinatorStartedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"actorUserId" text NOT NULL,
	"actorEmail" text NOT NULL,
	"actorLedgerPartyShortcode" text,
	"actorLedgerPartyName" text,
	"actorLedgerPartyKind" text,
	"predecessorRunId" uuid,
	"dispatchEventId" text,
	"agentSessionId" text,
	"historyCursorUrl" text,
	"historyExhaustedAt" timestamp,
	"channel" text DEFAULT 'web' NOT NULL,
	"oauthClientId" text,
	"deviceId" uuid,
	"clientKey" text,
	"input" jsonb,
	"progress" jsonb,
	CONSTRAINT "Run_trigger_check" CHECK ("Run"."trigger" IN ('foreground', 'discovery', 'manual', 'backfill', 'ephemeral')),
	CONSTRAINT "Run_import_party_check" CHECK ("Run"."purpose" NOT IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory') OR ("Run"."ledgerPartyId" IS NOT NULL AND "Run"."actorLedgerPartyShortcode" IS NOT NULL)),
	CONSTRAINT "Run_channel_check" CHECK ("Run"."channel" IN ('web', 'api', 'mcp', 'caldav', 'system')),
	CONSTRAINT "Run_status_check" CHECK ("Run"."status" IN ('running', 'paused_auth', 'paused_offline', 'paused_approval', 'needs_review', 'completed', 'failed', 'dispatch_failed')),
	CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'background', 'file_import', 'mail_search')),
	CONSTRAINT "Run_photo_inventory_no_vendor_check" CHECK ("Run"."purpose" <> 'photo_inventory' OR "Run"."vendorAccountId" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "Task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"projectId" uuid,
	"projectMode" text DEFAULT 'inherit' NOT NULL,
	"subjectProductId" uuid,
	"subjectProductMode" text DEFAULT 'inherit' NOT NULL,
	"parentTaskId" uuid,
	"dueDate" date,
	"dueEndDate" date,
	"trade" text,
	"sortOrder" double precision,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Vendor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"orderUrlTemplate" text,
	"orderEvidence" text,
	"orderEmailSenders" text[] DEFAULT '{}'::text[] NOT NULL,
	"browserDomains" text[] DEFAULT '{}'::text[] NOT NULL,
	"agentHints" jsonb DEFAULT '{"ordersListUrl":null,"pagination":null,"orderLinkPattern":null,"notes":[]}'::jsonb NOT NULL,
	"returnWindowDays" integer,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "Vendor_orderEvidence_check" CHECK ("Vendor"."orderEvidence" IS NULL OR "Vendor"."orderEvidence" IN ('online_account', 'receipt_only', 'not_expected')),
	CONSTRAINT "Vendor_returnWindowDays_check" CHECK ("Vendor"."returnWindowDays" IS NULL OR "Vendor"."returnWindowDays" >= 0)
);
--> statement-breakpoint
CREATE TABLE "VendorAccount" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"label" text NOT NULL,
	"vendorId" uuid NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"inventoryOwnerDefaultEnabled" boolean DEFAULT false NOT NULL,
	"browserSyncEnabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"browser" text DEFAULT 'chrome' NOT NULL,
	"cursor" jsonb DEFAULT '{"newestOrderAt":null,"orderIdsOnNewestDate":[],"backfillBeforeOrderAt":null,"earliestAvailableOrderAt":null}'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "VendorAccount_status_check" CHECK ("VendorAccount"."status" IN ('active', 'paused_auth', 'paused_offline', 'disabled')),
	CONSTRAINT "VendorAccount_browser_check" CHECK ("VendorAccount"."browser" IN ('chrome', 'safari'))
);
--> statement-breakpoint
CREATE TABLE "Wish" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"acquiredAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_deviceId_Device_id_fk" FOREIGN KEY ("deviceId") REFERENCES "public"."Device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DataException" ADD CONSTRAINT "DataException_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EntityAttachment" ADD CONSTRAINT "EntityAttachment_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EntityAttachment" ADD CONSTRAINT "EntityAttachment_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD CONSTRAINT "EntityEmbedding_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EntityExternalId" ADD CONSTRAINT "EntityExternalId_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "EntityExternalId" ADD CONSTRAINT "EntityExternalId_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_mergedIntoId_Entity_id_fk" FOREIGN KEY ("mergedIntoId") REFERENCES "public"."Entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_from_fk" FOREIGN KEY ("fromEntityId","fromKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_to_fk" FOREIGN KEY ("toEntityId","toKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ExpenseAttribution" ADD CONSTRAINT "ExpenseAttribution_expenseId_Expense_id_fk" FOREIGN KEY ("expenseId") REFERENCES "public"."Expense"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ExpenseAttribution" ADD CONSTRAINT "ExpenseAttribution_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ExternalSource" ADD CONSTRAINT "ExternalSource_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialTransactionAllocation" ADD CONSTRAINT "FinancialTransactionAllocation_transactionId_FinancialTransaction_id_fk" FOREIGN KEY ("transactionId") REFERENCES "public"."FinancialTransaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialTransactionAllocation" ADD CONSTRAINT "FinancialTransactionAllocation_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageDerivative" ADD CONSTRAINT "ImageDerivative_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageDescriptionCorrection" ADD CONSTRAINT "ImageDescriptionCorrection_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingAttempt" ADD CONSTRAINT "ImageProcessingAttempt_jobId_ImageProcessingJob_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."ImageProcessingJob"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingAttempt" ADD CONSTRAINT "ImageProcessingAttempt_submissionId_ImageProcessingSubmission_id_fk" FOREIGN KEY ("submissionId") REFERENCES "public"."ImageProcessingSubmission"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingEvent" ADD CONSTRAINT "ImageProcessingEvent_jobId_ImageProcessingJob_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."ImageProcessingJob"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_derivativeId_ImageDerivative_id_fk" FOREIGN KEY ("derivativeId") REFERENCES "public"."ImageDerivative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_submissionId_ImageProcessingSubmission_id_fk" FOREIGN KEY ("submissionId") REFERENCES "public"."ImageProcessingSubmission"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingSubmissionJob" ADD CONSTRAINT "ImageProcessingSubmissionJob_submissionId_ImageProcessingSubmission_id_fk" FOREIGN KEY ("submissionId") REFERENCES "public"."ImageProcessingSubmission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingSubmissionJob" ADD CONSTRAINT "ImageProcessingSubmissionJob_jobId_ImageProcessingJob_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."ImageProcessingJob"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageSighting" ADD CONSTRAINT "ImageSighting_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageSighting" ADD CONSTRAINT "ImageSighting_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageSighting" ADD CONSTRAINT "ImageSighting_deviceId_Device_id_fk" FOREIGN KEY ("deviceId") REFERENCES "public"."Device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportHunt" ADD CONSTRAINT "ImportHunt_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportHunt" ADD CONSTRAINT "ImportHunt_financialTransactionId_FinancialTransaction_id_fk" FOREIGN KEY ("financialTransactionId") REFERENCES "public"."FinancialTransaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportHunt" ADD CONSTRAINT "ImportHunt_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportHunt" ADD CONSTRAINT "ImportHunt_vendorAccountId_VendorAccount_id_fk" FOREIGN KEY ("vendorAccountId") REFERENCES "public"."VendorAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportHunt" ADD CONSTRAINT "ImportHunt_receiptImageId_Image_id_fk" FOREIGN KEY ("receiptImageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportHunt" ADD CONSTRAINT "ImportHunt_receiptRunId_Run_id_fk" FOREIGN KEY ("receiptRunId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportPreparedLine" ADD CONSTRAINT "ImportPreparedLine_preparedOrderId_ImportPreparedOrder_id_fk" FOREIGN KEY ("preparedOrderId") REFERENCES "public"."ImportPreparedOrder"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportPreparedOrder" ADD CONSTRAINT "ImportPreparedOrder_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportPreparedOrder" ADD CONSTRAINT "ImportPreparedOrder_primaryDocumentImageId_Image_id_fk" FOREIGN KEY ("primaryDocumentImageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportPreparedOrder" ADD CONSTRAINT "ImportPreparedOrder_screenshotImageId_Image_id_fk" FOREIGN KEY ("screenshotImageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" ADD CONSTRAINT "ImportSourceClaim_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" ADD CONSTRAINT "ImportSourceClaim_vendorAccountId_VendorAccount_id_fk" FOREIGN KEY ("vendorAccountId") REFERENCES "public"."VendorAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" ADD CONSTRAINT "ImportSourceClaim_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" ADD CONSTRAINT "ImportSourceClaim_firstRunId_Run_id_fk" FOREIGN KEY ("firstRunId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" ADD CONSTRAINT "ImportSourceClaim_lastRunId_Run_id_fk" FOREIGN KEY ("lastRunId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LedgerSourceClaim" ADD CONSTRAINT "LedgerSourceClaim_expenseId_Expense_id_fk" FOREIGN KEY ("expenseId") REFERENCES "public"."Expense"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LedgerSourceClaim" ADD CONSTRAINT "LedgerSourceClaim_ledgerTransferId_LedgerTransfer_id_fk" FOREIGN KEY ("ledgerTransferId") REFERENCES "public"."LedgerTransfer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LedgerSourceClaim" ADD CONSTRAINT "LedgerSourceClaim_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MailboxCursor" ADD CONSTRAINT "MailboxCursor_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "McpToolCall" ADD CONSTRAINT "McpToolCall_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealFoodEntry" ADD CONSTRAINT "MealFoodEntry_mealId_Meal_id_fk" FOREIGN KEY ("mealId") REFERENCES "public"."Meal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealFoodEntry" ADD CONSTRAINT "MealFoodEntry_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealFoodEntry" ADD CONSTRAINT "MealFoodEntry_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealFoodEntry" ADD CONSTRAINT "MealFoodEntry_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealRecipe" ADD CONSTRAINT "MealRecipe_mealId_Meal_id_fk" FOREIGN KEY ("mealId") REFERENCES "public"."Meal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealRecipe" ADD CONSTRAINT "MealRecipe_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealRecipePortion" ADD CONSTRAINT "MealRecipePortion_mealRecipeId_MealRecipe_id_fk" FOREIGN KEY ("mealRecipeId") REFERENCES "public"."MealRecipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealRecipePortion" ADD CONSTRAINT "MealRecipePortion_mealId_Meal_id_fk" FOREIGN KEY ("mealId") REFERENCES "public"."Meal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealRecipePortion" ADD CONSTRAINT "MealRecipePortion_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MerchantVendorRule" ADD CONSTRAINT "MerchantVendorRule_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MerchantVendorRule" ADD CONSTRAINT "MerchantVendorRule_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MerchantVendorRule" ADD CONSTRAINT "MerchantVendorRule_confirmedByUserId_user_id_fk" FOREIGN KEY ("confirmedByUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrderMail" ADD CONSTRAINT "OrderMail_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrderMail" ADD CONSTRAINT "OrderMail_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrderMailAttachment" ADD CONSTRAINT "OrderMailAttachment_orderMailId_OrderMail_id_fk" FOREIGN KEY ("orderMailId") REFERENCES "public"."OrderMail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrderMailAttachment" ADD CONSTRAINT "OrderMailAttachment_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrderMailCandidateDecision" ADD CONSTRAINT "OrderMailCandidateDecision_eventId_OrderMailEvent_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."OrderMailEvent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrderMailCandidateDecision" ADD CONSTRAINT "OrderMailCandidateDecision_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrderMailEvent" ADD CONSTRAINT "OrderMailEvent_orderMailId_OrderMail_id_fk" FOREIGN KEY ("orderMailId") REFERENCES "public"."OrderMail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD CONSTRAINT "PhotoGroupProposal_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD CONSTRAINT "PhotoGroupProposal_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD CONSTRAINT "PhotoGroupProposal_inventoryLocationId_Location_id_fk" FOREIGN KEY ("inventoryLocationId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD CONSTRAINT "PhotoGroupProposal_inventoryOwnerPartyId_LedgerParty_id_fk" FOREIGN KEY ("inventoryOwnerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD CONSTRAINT "PhotoGroupProposal_productCreateCategoryId_fk" FOREIGN KEY ("productCreateCategoryId") REFERENCES "public"."ProductCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductConversionCoverage" ADD CONSTRAINT "ProductConversionCoverage_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductMatchCandidate" ADD CONSTRAINT "ProductMatchCandidate_productAId_Product_id_fk" FOREIGN KEY ("productAId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductMatchCandidate" ADD CONSTRAINT "ProductMatchCandidate_productBId_Product_id_fk" FOREIGN KEY ("productBId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductUnitMapping" ADD CONSTRAINT "ProductUnitMapping_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PurchasePaymentEvidence" ADD CONSTRAINT "PurchasePaymentEvidence_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PurchasePaymentEvidence" ADD CONSTRAINT "PurchasePaymentEvidence_sourceClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("sourceClaimId") REFERENCES "public"."ImportSourceClaim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSection" ADD CONSTRAINT "RecipeSection_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSectionIngredient" ADD CONSTRAINT "RecipeSectionIngredient_recipeSectionId_RecipeSection_id_fk" FOREIGN KEY ("recipeSectionId") REFERENCES "public"."RecipeSection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSectionIngredient" ADD CONSTRAINT "RecipeSectionIngredient_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunApproval" ADD CONSTRAINT "RunApproval_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunApproval" ADD CONSTRAINT "RunApproval_decidedByUserId_user_id_fk" FOREIGN KEY ("decidedByUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunControlEvent" ADD CONSTRAINT "RunControlEvent_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunEvidence" ADD CONSTRAINT "RunEvidence_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunEvidence" ADD CONSTRAINT "RunEvidence_targetId_RunTarget_id_fk" FOREIGN KEY ("targetId") REFERENCES "public"."RunTarget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunFinding" ADD CONSTRAINT "RunFinding_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunFinding" ADD CONSTRAINT "RunFinding_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunFinding" ADD CONSTRAINT "RunFinding_resolvedByUserId_user_id_fk" FOREIGN KEY ("resolvedByUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunFinding" ADD CONSTRAINT "RunFinding_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunOperation" ADD CONSTRAINT "RunOperation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunOrderCandidate" ADD CONSTRAINT "RunOrderCandidate_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunProgress" ADD CONSTRAINT "RunProgress_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_vendorAccountId_VendorAccount_id_fk" FOREIGN KEY ("vendorAccountId") REFERENCES "public"."VendorAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_deviceWorkDeviceId_Device_id_fk" FOREIGN KEY ("deviceWorkDeviceId") REFERENCES "public"."Device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SearchDocument" ADD CONSTRAINT "SearchDocument_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_batchId_StatementImport_id_fk" FOREIGN KEY ("batchId") REFERENCES "public"."StatementImport"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_accountId_FinancialAccount_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."FinancialAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_supersededByRowId_StatementRow_id_fk" FOREIGN KEY ("supersededByRowId") REFERENCES "public"."StatementRow"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SuggestionDismissal" ADD CONSTRAINT "SuggestionDismissal_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Cookbook" ADD CONSTRAINT "Cookbook_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Cookbook" ADD CONSTRAINT "Cookbook_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Device" ADD CONSTRAINT "Device_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Device" ADD CONSTRAINT "Device_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Device" ADD CONSTRAINT "Device_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_providerVendorId_Vendor_id_fk" FOREIGN KEY ("providerVendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_accountId_FinancialAccount_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."FinancialAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_ledgerTransferId_LedgerTransfer_id_fk" FOREIGN KEY ("ledgerTransferId") REFERENCES "public"."LedgerTransfer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GardenEntry" ADD CONSTRAINT "GardenEntry_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GardenEntry" ADD CONSTRAINT "GardenEntry_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Image" ADD CONSTRAINT "Image_capturedByPartyId_LedgerParty_id_fk" FOREIGN KEY ("capturedByPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Image" ADD CONSTRAINT "Image_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_ownerLedgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ownerLedgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LedgerParty" ADD CONSTRAINT "LedgerParty_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LedgerParty" ADD CONSTRAINT "LedgerParty_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LedgerTransfer" ADD CONSTRAINT "LedgerTransfer_fromPartyId_LedgerParty_id_fk" FOREIGN KEY ("fromPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LedgerTransfer" ADD CONSTRAINT "LedgerTransfer_toPartyId_LedgerParty_id_fk" FOREIGN KEY ("toPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LedgerTransfer" ADD CONSTRAINT "LedgerTransfer_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentId_Location_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Location" ADD CONSTRAINT "Location_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Location" ADD CONSTRAINT "Location_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Meal" ADD CONSTRAINT "Meal_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Plant" ADD CONSTRAINT "Plant_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Plant" ADD CONSTRAINT "Plant_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_plantId_Plant_id_fk" FOREIGN KEY ("plantId") REFERENCES "public"."Plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_sourceProductId_Product_id_fk" FOREIGN KEY ("sourceProductId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Planting" ADD CONSTRAINT "Planting_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_growsPlantId_Plant_id_fk" FOREIGN KEY ("growsPlantId") REFERENCES "public"."Plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_ProductCategory_id_fk" FOREIGN KEY ("categoryId") REFERENCES "public"."ProductCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parentId_ProductCategory_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."ProductCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Project" ADD CONSTRAINT "Project_parentProjectId_Project_id_fk" FOREIGN KEY ("parentProjectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Project" ADD CONSTRAINT "Project_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_vendorAccountId_VendorAccount_id_fk" FOREIGN KEY ("vendorAccountId") REFERENCES "public"."VendorAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_defaultProjectId_Project_id_fk" FOREIGN KEY ("defaultProjectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_cookbookId_Cookbook_id_fk" FOREIGN KEY ("cookbookId") REFERENCES "public"."Cookbook"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_forkedFromRecipeId_Recipe_id_fk" FOREIGN KEY ("forkedFromRecipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_vendorAccountId_VendorAccount_id_fk" FOREIGN KEY ("vendorAccountId") REFERENCES "public"."VendorAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_actorUserId_user_id_fk" FOREIGN KEY ("actorUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_predecessorRunId_Run_id_fk" FOREIGN KEY ("predecessorRunId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Task" ADD CONSTRAINT "Task_subjectProductId_Product_id_fk" FOREIGN KEY ("subjectProductId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentTaskId_Task_id_fk" FOREIGN KEY ("parentTaskId") REFERENCES "public"."Task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Task" ADD CONSTRAINT "Task_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "VendorAccount" ADD CONSTRAINT "VendorAccount_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "VendorAccount" ADD CONSTRAINT "VendorAccount_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "VendorAccount" ADD CONSTRAINT "VendorAccount_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Wish" ADD CONSTRAINT "Wish_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "AiAnalysis_active_key" ON "AiAnalysis" USING btree ("entityKind","entityId","feature","model","promptVersion","inputFingerprint",coalesce("provider", ''),coalesce("resultSchemaRevision", 0)) WHERE "AiAnalysis"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "AiAnalysis_entity_idx" ON "AiAnalysis" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE INDEX "AiAnalysis_feature_idx" ON "AiAnalysis" USING btree ("feature");--> statement-breakpoint
CREATE INDEX "AiUsage_feature_createdAt_idx" ON "AiUsage" USING btree ("feature","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "AiUsage_model_createdAt_idx" ON "AiUsage" USING btree ("model","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "AiUsage_entity_idx" ON "AiUsage" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE INDEX "AiUsage_job_idx" ON "AiUsage" USING btree ("jobKind","jobId");--> statement-breakpoint
CREATE INDEX "AiUsage_run_idx" ON "AiUsage" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog" USING btree ("createdAt" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "AuditLog_runId_entityKind_idx" ON "AuditLog" USING btree ("runId","entityKind") WHERE "AuditLog"."runId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "AuditLog_entityKind_entityId_createdAt_idx" ON "AuditLog" USING btree ("entityKind","entityId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "DataException_entity_check_key" ON "DataException" USING btree ("entityId","check");--> statement-breakpoint
CREATE UNIQUE INDEX "EntityAttachment_entity_image_key" ON "EntityAttachment" USING btree ("entityId","imageId") WHERE "EntityAttachment"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "EntityAttachment_entity_singular_role_key" ON "EntityAttachment" USING btree ("entityId","role") WHERE "EntityAttachment"."role" IN ('cover', 'logo') AND "EntityAttachment"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "EntityAttachment_entity_idempotency_key" ON "EntityAttachment" USING btree ("entityId","idempotencyKey") WHERE "EntityAttachment"."idempotencyKey" IS NOT NULL AND "EntityAttachment"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "EntityAttachment_entity_order_idx" ON "EntityAttachment" USING btree ("entityId","sortOrder");--> statement-breakpoint
CREATE INDEX "EntityAttachment_imageId_idx" ON "EntityAttachment" USING btree ("imageId");--> statement-breakpoint
CREATE UNIQUE INDEX "EntityEmbedding_entity_model_key" ON "EntityEmbedding" USING btree ("entityKind","entityId","provider","model","dimensions") WHERE "EntityEmbedding"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "EntityEmbedding_entity_idx" ON "EntityEmbedding" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE INDEX "EntityEmbedding_model_idx" ON "EntityEmbedding" USING btree ("provider","model","dimensions");--> statement-breakpoint
CREATE UNIQUE INDEX "EntityExternalId_source_kind_externalId_key" ON "EntityExternalId" USING btree ("source","kind","externalId") WHERE "EntityExternalId"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "EntityExternalId_entity_source_kind_primary_key" ON "EntityExternalId" USING btree ("entityId","source","kind") WHERE "EntityExternalId"."isPrimary" AND "EntityExternalId"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "EntityExternalId_entityId_idx" ON "EntityExternalId" USING btree ("entityId");--> statement-breakpoint
CREATE UNIQUE INDEX "Entity_shortcode_unique" ON "Entity" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Entity_mergedIntoId_idx" ON "Entity" USING btree ("mergedIntoId");--> statement-breakpoint
CREATE UNIQUE INDEX "EntityLink_kind_from_to_key" ON "EntityLink" USING btree ("kind","fromEntityId","toEntityId") WHERE "EntityLink"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "EntityLink_to_kind_idx" ON "EntityLink" USING btree ("toEntityId","kind") WHERE "EntityLink"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ExpenseAttribution_expenseId_role_ledgerPartyId_key" ON "ExpenseAttribution" USING btree ("expenseId","role","ledgerPartyId") WHERE "ExpenseAttribution"."deletedAt" IS NULL AND "ExpenseAttribution"."ledgerPartyId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ExpenseAttribution_expenseId_role_unattributed_key" ON "ExpenseAttribution" USING btree ("expenseId","role") WHERE "ExpenseAttribution"."deletedAt" IS NULL AND "ExpenseAttribution"."ledgerPartyId" IS NULL;--> statement-breakpoint
CREATE INDEX "ExpenseAttribution_expenseId_idx" ON "ExpenseAttribution" USING btree ("expenseId");--> statement-breakpoint
CREATE INDEX "ExpenseAttribution_ledgerPartyId_idx" ON "ExpenseAttribution" USING btree ("ledgerPartyId");--> statement-breakpoint
CREATE UNIQUE INDEX "FinancialTransactionAllocation_transactionId_purchaseId_key" ON "FinancialTransactionAllocation" USING btree ("transactionId","purchaseId") WHERE "FinancialTransactionAllocation"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "FinancialTransactionAllocation_transactionId_idx" ON "FinancialTransactionAllocation" USING btree ("transactionId");--> statement-breakpoint
CREATE INDEX "FinancialTransactionAllocation_purchaseId_idx" ON "FinancialTransactionAllocation" USING btree ("purchaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageDerivative_image_purpose_source_revision_key" ON "ImageDerivative" USING btree ("imageId","purpose","sourceContentHash","processorRevision") WHERE "ImageDerivative"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ImageDerivative_storage_key_key" ON "ImageDerivative" USING btree ("key") WHERE "ImageDerivative"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "ImageDerivative_image_idx" ON "ImageDerivative" USING btree ("imageId");--> statement-breakpoint
CREATE INDEX "ImageDerivative_status_idx" ON "ImageDerivative" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ImageDescriptionCorrection_image_idx" ON "ImageDescriptionCorrection" USING btree ("imageId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageDescriptionCorrection_active_image_key" ON "ImageDescriptionCorrection" USING btree ("imageId") WHERE "ImageDescriptionCorrection"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ImageProcessingAttempt_job_number_key" ON "ImageProcessingAttempt" USING btree ("jobId","number");--> statement-breakpoint
CREATE INDEX "ImageProcessingAttempt_device_idx" ON "ImageProcessingAttempt" USING btree (("executor"->>'deviceId'));--> statement-breakpoint
CREATE INDEX "ImageProcessingAttempt_submission_idx" ON "ImageProcessingAttempt" USING btree ("submissionId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageProcessingEvent_job_event_key" ON "ImageProcessingEvent" USING btree ("jobId","eventKey");--> statement-breakpoint
CREATE INDEX "ImageProcessingEvent_job_time_idx" ON "ImageProcessingEvent" USING btree ("jobId","occurredAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageProcessingJob_publicId_key" ON "ImageProcessingJob" USING btree ("publicId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageProcessingJob_identity_key" ON "ImageProcessingJob" USING btree ("imageId","kind","sourceContentHash","processorRevision");--> statement-breakpoint
CREATE INDEX "ImageProcessingJob_dispatch_idx" ON "ImageProcessingJob" USING btree ("state","nextAttemptAt");--> statement-breakpoint
CREATE INDEX "ImageProcessingJob_runId_idx" ON "ImageProcessingJob" USING btree ("runId") WHERE "ImageProcessingJob"."runId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ImageProcessingOrphan_key_key" ON "ImageProcessingOrphan" USING btree ("key");--> statement-breakpoint
CREATE INDEX "ImageProcessingOrphan_createdAt_idx" ON "ImageProcessingOrphan" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageProcessingSubmission_publicId_key" ON "ImageProcessingSubmission" USING btree ("publicId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageProcessingSubmissionJob_membership_key" ON "ImageProcessingSubmissionJob" USING btree ("submissionId","jobId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageSighting_image_party_asset_key" ON "ImageSighting" USING btree ("imageId","ledgerPartyId","assetKey") WHERE "ImageSighting"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "ImageSighting_imageId_idx" ON "ImageSighting" USING btree ("imageId");--> statement-breakpoint
CREATE INDEX "ImageSighting_ledgerPartyId_idx" ON "ImageSighting" USING btree ("ledgerPartyId");--> statement-breakpoint
CREATE INDEX "ImageSighting_deviceId_idx" ON "ImageSighting" USING btree ("deviceId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImportHunt_transaction_key" ON "ImportHunt" USING btree ("financialTransactionId");--> statement-breakpoint
CREATE INDEX "ImportHunt_worklist_idx" ON "ImportHunt" USING btree ("state","updatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ImportHunt_receipt_image_key" ON "ImportHunt" USING btree ("id","receiptImageId") WHERE "ImportHunt"."receiptImageId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ImportHunt_receipt_run_idx" ON "ImportHunt" USING btree ("receiptRunId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImportPreparedLine_order_stable_line_key" ON "ImportPreparedLine" USING btree ("preparedOrderId","stableLineId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImportPreparedLine_order_position_key" ON "ImportPreparedLine" USING btree ("preparedOrderId","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ImportPreparedOrder_run_item_operation_key" ON "ImportPreparedOrder" USING btree ("runId","itemOperationId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImportPreparedOrder_run_stable_order_key" ON "ImportPreparedOrder" USING btree ("runId","stableOrderId");--> statement-breakpoint
CREATE INDEX "ImportPreparedOrder_prepare_operation_idx" ON "ImportPreparedOrder" USING btree ("runId","prepareOperationId");--> statement-breakpoint
CREATE UNIQUE INDEX "ImportSourceClaim_source_key" ON "ImportSourceClaim" USING btree ("ledgerPartyId","kind","externalKey");--> statement-breakpoint
CREATE INDEX "ImportSourceClaim_purchase_idx" ON "ImportSourceClaim" USING btree ("purchaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "LedgerSourceClaim_source_sourceKey_key" ON "LedgerSourceClaim" USING btree ("source","sourceKey");--> statement-breakpoint
CREATE INDEX "LedgerSourceClaim_expenseId_idx" ON "LedgerSourceClaim" USING btree ("expenseId");--> statement-breakpoint
CREATE INDEX "LedgerSourceClaim_ledgerTransferId_idx" ON "LedgerSourceClaim" USING btree ("ledgerTransferId");--> statement-breakpoint
CREATE UNIQUE INDEX "MailboxCursor_party_provider_key" ON "MailboxCursor" USING btree ("ledgerPartyId","provider");--> statement-breakpoint
CREATE INDEX "McpToolCall_tool_occurredAt_idx" ON "McpToolCall" USING btree ("toolName","occurredAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "McpToolCall_user_occurredAt_idx" ON "McpToolCall" USING btree ("userId","occurredAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "McpToolCall_client_occurredAt_idx" ON "McpToolCall" USING btree ("clientId","occurredAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "McpToolCall_outcome_idx" ON "McpToolCall" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "McpToolCall_release_idx" ON "McpToolCall" USING btree ("release");--> statement-breakpoint
CREATE INDEX "McpToolCall_entity_occurredAt_idx" ON "McpToolCall" USING btree ("entityKind","occurredAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "MealFoodEntry_mealId_idx" ON "MealFoodEntry" USING btree ("mealId");--> statement-breakpoint
CREATE INDEX "MealFoodEntry_ledgerPartyId_idx" ON "MealFoodEntry" USING btree ("ledgerPartyId");--> statement-breakpoint
CREATE INDEX "MealFoodEntry_ingredientId_idx" ON "MealFoodEntry" USING btree ("ingredientId");--> statement-breakpoint
CREATE INDEX "MealFoodEntry_productId_idx" ON "MealFoodEntry" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "MealRecipe_mealId_idx" ON "MealRecipe" USING btree ("mealId");--> statement-breakpoint
CREATE INDEX "MealRecipe_recipeId_idx" ON "MealRecipe" USING btree ("recipeId");--> statement-breakpoint
CREATE UNIQUE INDEX "MealRecipePortion_live_source_target_eater_key" ON "MealRecipePortion" USING btree ("mealRecipeId","mealId","ledgerPartyId") WHERE "MealRecipePortion"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "MealRecipePortion_mealRecipeId_idx" ON "MealRecipePortion" USING btree ("mealRecipeId");--> statement-breakpoint
CREATE INDEX "MealRecipePortion_mealId_idx" ON "MealRecipePortion" USING btree ("mealId");--> statement-breakpoint
CREATE INDEX "MealRecipePortion_ledgerPartyId_idx" ON "MealRecipePortion" USING btree ("ledgerPartyId");--> statement-breakpoint
CREATE UNIQUE INDEX "MerchantVendorRule_party_merchant_key" ON "MerchantVendorRule" USING btree ("ledgerPartyId","normalizedMerchant");--> statement-breakpoint
CREATE INDEX "oauth_access_token_client_id_idx" ON "oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_session_id_idx" ON "oauth_access_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_idx" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_refresh_id_idx" ON "oauth_access_token" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_authorization_code_id_idx" ON "oauth_access_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_client_user_id_idx" ON "oauth_client" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_client_id_idx" ON "oauth_client_resource" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_resource_id_idx" ON "oauth_client_resource" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_resource_client_id_resource_id_unique" ON "oauth_client_resource" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_client_id_idx" ON "oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_idx" ON "oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_client_id_idx" ON "oauth_refresh_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_session_id_idx" ON "oauth_refresh_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_user_id_idx" ON "oauth_refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_authorization_code_id_idx" ON "oauth_refresh_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "OrderMail_party_message_key" ON "OrderMail" USING btree ("ledgerPartyId","messageId");--> statement-breakpoint
CREATE INDEX "OrderMail_party_received_idx" ON "OrderMail" USING btree ("ledgerPartyId","receivedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "OrderMailAttachment_provider_key" ON "OrderMailAttachment" USING btree ("orderMailId","providerAttachmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "OrderMailCandidateDecision_event_purchase_key" ON "OrderMailCandidateDecision" USING btree ("eventId","purchaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "OrderMailCandidateDecision_one_link_key" ON "OrderMailCandidateDecision" USING btree ("eventId") WHERE "OrderMailCandidateDecision"."decision" = 'linked';--> statement-breakpoint
CREATE INDEX "OrderMailCandidateDecision_purchase_idx" ON "OrderMailCandidateDecision" USING btree ("purchaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "OrderMailEvent_source_key" ON "OrderMailEvent" USING btree ("orderMailId","sourceKey");--> statement-breakpoint
CREATE INDEX "OrderMailEvent_order_idx" ON "OrderMailEvent" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credential_id_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "PhotoGroupProposal_run_group_key" ON "PhotoGroupProposal" USING btree ("runId","groupKey");--> statement-breakpoint
CREATE INDEX "PhotoGroupProposal_product_idx" ON "PhotoGroupProposal" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "PhotoGroupProposal_location_idx" ON "PhotoGroupProposal" USING btree ("inventoryLocationId");--> statement-breakpoint
CREATE INDEX "ProductConversionCoverage_tier_idx" ON "ProductConversionCoverage" USING btree ("coverageTier");--> statement-breakpoint
CREATE INDEX "ProductConversionCoverage_island_idx" ON "ProductConversionCoverage" USING btree ("islandCount");--> statement-breakpoint
CREATE INDEX "ProductConversionCoverage_status_idx" ON "ProductConversionCoverage" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ProductMatchCandidate_pair_key" ON "ProductMatchCandidate" USING btree ("productAId","productBId");--> statement-breakpoint
CREATE INDEX "ProductMatchCandidate_productB_idx" ON "ProductMatchCandidate" USING btree ("productBId");--> statement-breakpoint
CREATE INDEX "ProductUnitMapping_productId_idx" ON "ProductUnitMapping" USING btree ("productId");--> statement-breakpoint
CREATE UNIQUE INDEX "PurchasePaymentEvidence_source_index_key" ON "PurchasePaymentEvidence" USING btree ("sourceClaimId","evidenceIndex");--> statement-breakpoint
CREATE INDEX "PurchasePaymentEvidence_purchase_idx" ON "PurchasePaymentEvidence" USING btree ("purchaseId");--> statement-breakpoint
CREATE INDEX "RecipeSection_recipeId_idx" ON "RecipeSection" USING btree ("recipeId");--> statement-breakpoint
CREATE INDEX "RecipeSection_createdAt_idx" ON "RecipeSection" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "RecipeSectionIngredient_recipeSectionId_idx" ON "RecipeSectionIngredient" USING btree ("recipeSectionId");--> statement-breakpoint
CREATE INDEX "RecipeSectionIngredient_ingredientId_idx" ON "RecipeSectionIngredient" USING btree ("ingredientId");--> statement-breakpoint
CREATE UNIQUE INDEX "RunApproval_run_operation_key" ON "RunApproval" USING btree ("runId","operationId");--> statement-breakpoint
CREATE INDEX "RunApproval_run_state_idx" ON "RunApproval" USING btree ("runId","state");--> statement-breakpoint
CREATE INDEX "RunControlEvent_run_created_idx" ON "RunControlEvent" USING btree ("runId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "RunEvidence_object_key_unique" ON "RunEvidence" USING btree ("objectKey");--> statement-breakpoint
CREATE INDEX "RunEvidence_run_target_idx" ON "RunEvidence" USING btree ("runId","targetId");--> statement-breakpoint
CREATE UNIQUE INDEX "RunFinding_open_evidence_key" ON "RunFinding" USING btree ("ledgerPartyId","entityKind","entityId","kind","evidenceFingerprint") WHERE "RunFinding"."status" = 'open';--> statement-breakpoint
CREATE INDEX "RunFinding_status_idx" ON "RunFinding" USING btree ("status","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "RunOperation_run_operation_key" ON "RunOperation" USING btree ("runId","operationId");--> statement-breakpoint
CREATE INDEX "RunOperation_run_state_idx" ON "RunOperation" USING btree ("runId","state");--> statement-breakpoint
CREATE UNIQUE INDEX "RunOrderCandidate_run_order_key" ON "RunOrderCandidate" USING btree ("runId","orderId");--> statement-breakpoint
CREATE INDEX "RunOrderCandidate_run_state_idx" ON "RunOrderCandidate" USING btree ("runId","state");--> statement-breakpoint
CREATE UNIQUE INDEX "RunProgress_eventId_unique" ON "RunProgress" USING btree ("eventId");--> statement-breakpoint
CREATE INDEX "RunProgress_run_created_idx" ON "RunProgress" USING btree ("runId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "RunTarget_run_idx" ON "RunTarget" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "RunTarget_entity_idx" ON "RunTarget" USING btree ("entityId");--> statement-breakpoint
CREATE INDEX "RunTarget_deviceWorkDeviceId_idx" ON "RunTarget" USING btree ("deviceWorkDeviceId") WHERE "RunTarget"."deviceWorkDeviceId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "RunTarget_run_entity_key" ON "RunTarget" USING btree ("runId","entityId");--> statement-breakpoint
CREATE UNIQUE INDEX "SearchDocument_live_entity_key" ON "SearchDocument" USING btree ("entityKind","entityId") WHERE "SearchDocument"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "SearchDocument_title_active_idx" ON "SearchDocument" USING btree (lower("title") text_pattern_ops) WHERE "SearchDocument"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "SearchDocument_vector_gin_idx" ON "SearchDocument" USING gin ("searchVector") WHERE "SearchDocument"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "SearchDocument_normalized_gist_idx" ON "SearchDocument" USING gist ("normalizedText" gist_trgm_ops) WHERE "SearchDocument"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "StatementImport_source_fingerprint_key" ON "StatementImport" USING btree ("source","fingerprint") WHERE "StatementImport"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "StatementImport_source_idx" ON "StatementImport" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "StatementRow_source_externalId_key" ON "StatementRow" USING btree ("source","externalId") WHERE "StatementRow"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "StatementRow_batchId_idx" ON "StatementRow" USING btree ("batchId");--> statement-breakpoint
CREATE INDEX "StatementRow_statementDate_idx" ON "StatementRow" USING btree ("statementDate");--> statement-breakpoint
CREATE INDEX "StatementRow_worklist_idx" ON "StatementRow" USING btree ("statementDate" DESC NULLS LAST) WHERE "StatementRow"."deletedAt" IS NULL AND "StatementRow"."disposition" = 'open' AND "StatementRow"."supersededByRowId" IS NULL;--> statement-breakpoint
CREATE INDEX "StatementRow_account_date_amount_idx" ON "StatementRow" USING btree ("accountId","statementDate","amount");--> statement-breakpoint
CREATE INDEX "StatementRow_descriptor_date_amount_idx" ON "StatementRow" USING btree ("source","accountDescriptor","statementDate","providerAmount");--> statement-breakpoint
CREATE INDEX "StatementRow_rawDescription_gin_idx" ON "StatementRow" USING gin ("rawDescription" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "SuggestionDismissal_active_key" ON "SuggestionDismissal" USING btree ("entityKind","entityId","suggestionKind","candidateKey") WHERE "SuggestionDismissal"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "SuggestionDismissal_source_idx" ON "SuggestionDismissal" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE INDEX "UpcLookupCache_fetchedAt_idx" ON "UpcLookupCache" USING btree ("fetchedAt");--> statement-breakpoint
CREATE INDEX "UpcLookupCache_status_idx" ON "UpcLookupCache" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "Cookbook_shortcode_unique" ON "Cookbook" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Cookbook_name_key" ON "Cookbook" USING btree ("name") WHERE "Cookbook"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Cookbook_createdAt_idx" ON "Cookbook" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Cookbook_name_gin_idx" ON "Cookbook" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Cookbook_productId_idx" ON "Cookbook" USING btree ("productId");--> statement-breakpoint
CREATE UNIQUE INDEX "Device_shortcode_unique" ON "Device" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Device_installationId_key" ON "Device" USING btree ("installationId") WHERE "Device"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Device_ledgerPartyId_idx" ON "Device" USING btree ("ledgerPartyId");--> statement-breakpoint
CREATE INDEX "Device_productId_idx" ON "Device" USING btree ("productId");--> statement-breakpoint
CREATE UNIQUE INDEX "Expense_shortcode_unique" ON "Expense" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Expense_date_idx" ON "Expense" USING btree ("date");--> statement-breakpoint
CREATE INDEX "Expense_costType_idx" ON "Expense" USING btree ("costType");--> statement-breakpoint
CREATE INDEX "Expense_lineKind_idx" ON "Expense" USING btree ("lineKind");--> statement-breakpoint
CREATE INDEX "Expense_name_gin_idx" ON "Expense" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Expense_projectId_idx" ON "Expense" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "Expense_productId_idx" ON "Expense" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "Expense_purchaseId_idx" ON "Expense" USING btree ("purchaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "FinancialAccount_shortcode_unique" ON "FinancialAccount" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "FinancialAccount_name_idx" ON "FinancialAccount" USING btree ("name");--> statement-breakpoint
CREATE INDEX "FinancialAccount_provisional_idx" ON "FinancialAccount" USING btree ("provisional");--> statement-breakpoint
CREATE UNIQUE INDEX "FinancialAccount_provider_owner_key" ON "FinancialAccount" USING btree ("providerVendorId","ledgerPartyId") WHERE "FinancialAccount"."providerVendorId" IS NOT NULL AND "FinancialAccount"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "FinancialAccount_ledgerPartyId_idx" ON "FinancialAccount" USING btree ("ledgerPartyId");--> statement-breakpoint
CREATE UNIQUE INDEX "FinancialTransaction_shortcode_unique" ON "FinancialTransaction" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "FinancialTransaction_ledgerTransferId_positive_evidence_key" ON "FinancialTransaction" USING btree ("ledgerTransferId") WHERE "FinancialTransaction"."deletedAt" IS NULL AND "FinancialTransaction"."ledgerTransferId" IS NOT NULL AND "FinancialTransaction"."amount" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "FinancialTransaction_ledgerTransferId_negative_evidence_key" ON "FinancialTransaction" USING btree ("ledgerTransferId") WHERE "FinancialTransaction"."deletedAt" IS NULL AND "FinancialTransaction"."ledgerTransferId" IS NOT NULL AND "FinancialTransaction"."amount" < 0;--> statement-breakpoint
CREATE INDEX "FinancialTransaction_kind_idx" ON "FinancialTransaction" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "FinancialTransaction_status_idx" ON "FinancialTransaction" USING btree ("status");--> statement-breakpoint
CREATE INDEX "FinancialTransaction_transactionDate_idx" ON "FinancialTransaction" USING btree ("transactionDate");--> statement-breakpoint
CREATE INDEX "FinancialTransaction_postedDate_idx" ON "FinancialTransaction" USING btree ("postedDate");--> statement-breakpoint
CREATE INDEX "FinancialTransaction_accountId_idx" ON "FinancialTransaction" USING btree ("accountId");--> statement-breakpoint
CREATE INDEX "FinancialTransaction_ledgerTransferId_idx" ON "FinancialTransaction" USING btree ("ledgerTransferId");--> statement-breakpoint
CREATE UNIQUE INDEX "GardenEntry_shortcode_unique" ON "GardenEntry" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "GardenEntry_observedOn_idx" ON "GardenEntry" USING btree ("observedOn");--> statement-breakpoint
CREATE INDEX "GardenEntry_locationId_idx" ON "GardenEntry" USING btree ("locationId");--> statement-breakpoint
CREATE UNIQUE INDEX "Image_shortcode_unique" ON "Image" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Image_key_key" ON "Image" USING btree ("key") WHERE "Image"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Image_createdAt_idx" ON "Image" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Image_status_idx" ON "Image" USING btree ("status");--> statement-breakpoint
CREATE INDEX "Image_capturedByPartyId_idx" ON "Image" USING btree ("capturedByPartyId");--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_shortcode_unique" ON "Ingredient" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient" USING btree (lower("name")) WHERE "Ingredient"."deletedAt" IS NULL AND "Ingredient"."recipeId" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_recipeId_key" ON "Ingredient" USING btree ("recipeId") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Ingredient_createdAt_idx" ON "Ingredient" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Ingredient_name_gin_idx" ON "Ingredient" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Ingredient_name_active_idx" ON "Ingredient" USING btree ("name") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Ingredient_recipeId_idx" ON "Ingredient" USING btree ("recipeId");--> statement-breakpoint
CREATE UNIQUE INDEX "InventoryEntry_shortcode_unique" ON "InventoryEntry" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "InventoryEntry_productId_locationId_key" ON "InventoryEntry" USING btree ("productId","locationId","placement","ownershipMode",coalesce("ownerLedgerPartyId", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "InventoryEntry"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "InventoryEntry_owner_idx" ON "InventoryEntry" USING btree ("ownerLedgerPartyId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_createdAt_idx" ON "InventoryEntry" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "InventoryEntry_productId_idx" ON "InventoryEntry" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_locationId_idx" ON "InventoryEntry" USING btree ("locationId");--> statement-breakpoint
CREATE UNIQUE INDEX "LedgerParty_shortcode_unique" ON "LedgerParty" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "LedgerParty_kind_idx" ON "LedgerParty" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "LedgerParty_household_singleton_key" ON "LedgerParty" USING btree ("kind") WHERE "LedgerParty"."deletedAt" IS NULL AND "LedgerParty"."kind" = 'household';--> statement-breakpoint
CREATE UNIQUE INDEX "LedgerParty_member_user_key" ON "LedgerParty" USING btree ("userId") WHERE "LedgerParty"."deletedAt" IS NULL AND "LedgerParty"."userId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "LedgerTransfer_shortcode_unique" ON "LedgerTransfer" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "LedgerTransfer_date_idx" ON "LedgerTransfer" USING btree ("date");--> statement-breakpoint
CREATE INDEX "LedgerTransfer_fromPartyId_idx" ON "LedgerTransfer" USING btree ("fromPartyId");--> statement-breakpoint
CREATE INDEX "LedgerTransfer_toPartyId_idx" ON "LedgerTransfer" USING btree ("toPartyId");--> statement-breakpoint
CREATE UNIQUE INDEX "Location_shortcode_unique" ON "Location" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Location_name_key" ON "Location" USING btree (lower("name")) WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Location_name_idx" ON "Location" USING btree ("name");--> statement-breakpoint
CREATE INDEX "Location_tags_idx" ON "Location" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "Location_createdAt_idx" ON "Location" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Location_lastBulkInventory_idx" ON "Location" USING btree ("lastBulkInventory");--> statement-breakpoint
CREATE INDEX "Location_name_gin_idx" ON "Location" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Location_type_name_idx" ON "Location" USING btree ("type","name");--> statement-breakpoint
CREATE INDEX "Location_name_active_idx" ON "Location" USING btree ("name") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Location_type_active_idx" ON "Location" USING btree ("type") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Location_parentId_idx" ON "Location" USING btree ("parentId");--> statement-breakpoint
CREATE INDEX "Location_productId_idx" ON "Location" USING btree ("productId");--> statement-breakpoint
CREATE UNIQUE INDEX "Meal_shortcode_unique" ON "Meal" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Meal_date_active_idx" ON "Meal" USING btree ("date") WHERE "Meal"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Plant_shortcode_unique" ON "Plant" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Plant_gardenGuideKey_idx" ON "Plant" USING btree ("gardenGuideKey");--> statement-breakpoint
CREATE INDEX "Plant_ingredientId_idx" ON "Plant" USING btree ("ingredientId");--> statement-breakpoint
CREATE UNIQUE INDEX "Planting_shortcode_unique" ON "Planting" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Planting_status_idx" ON "Planting" USING btree ("status");--> statement-breakpoint
CREATE INDEX "Planting_plantId_idx" ON "Planting" USING btree ("plantId");--> statement-breakpoint
CREATE INDEX "Planting_sourceProductId_idx" ON "Planting" USING btree ("sourceProductId");--> statement-breakpoint
CREATE INDEX "Planting_locationId_idx" ON "Planting" USING btree ("locationId");--> statement-breakpoint
CREATE INDEX "Planting_taskId_idx" ON "Planting" USING btree ("taskId");--> statement-breakpoint
CREATE UNIQUE INDEX "Product_shortcode_unique" ON "Product" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Product_name_manufacturer_key" ON "Product" USING btree ("name","manufacturer") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_createdAt_idx" ON "Product" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Product_name_gin_idx" ON "Product" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Product_manufacturer_gin_idx" ON "Product" USING gin ("manufacturer" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Product_name_manufacturer_idx" ON "Product" USING btree ("name","manufacturer");--> statement-breakpoint
CREATE INDEX "Product_name_active_idx" ON "Product" USING btree ("name") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_manufacturer_active_idx" ON "Product" USING btree ("manufacturer") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_ingredientId_idx" ON "Product" USING btree ("ingredientId");--> statement-breakpoint
CREATE INDEX "Product_growsPlantId_idx" ON "Product" USING btree ("growsPlantId");--> statement-breakpoint
CREATE INDEX "Product_categoryId_idx" ON "Product" USING btree ("categoryId");--> statement-breakpoint
CREATE UNIQUE INDEX "ProductCategory_shortcode_unique" ON "ProductCategory" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "ProductCategory_parent_name_key" ON "ProductCategory" USING btree ("parentId","name") WHERE "ProductCategory"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ProductCategory_feature_live_unique" ON "ProductCategory" USING btree ("feature") WHERE "ProductCategory"."deletedAt" IS NULL AND "ProductCategory"."feature" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ProductCategory_feature_idx" ON "ProductCategory" USING btree ("feature");--> statement-breakpoint
CREATE INDEX "ProductCategory_parentId_idx" ON "ProductCategory" USING btree ("parentId");--> statement-breakpoint
CREATE UNIQUE INDEX "Project_shortcode_unique" ON "Project" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Project_status_idx" ON "Project" USING btree ("status");--> statement-breakpoint
CREATE INDEX "Project_kind_idx" ON "Project" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "Project_startDate_idx" ON "Project" USING btree ("startDate");--> statement-breakpoint
CREATE INDEX "Project_name_gin_idx" ON "Project" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Project_name_active_idx" ON "Project" USING btree ("name") WHERE "Project"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Project_parentProjectId_idx" ON "Project" USING btree ("parentProjectId");--> statement-breakpoint
CREATE UNIQUE INDEX "Purchase_shortcode_unique" ON "Purchase" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Purchase_vendorId_orderId_key" ON "Purchase" USING btree ("vendorId","orderId") WHERE "Purchase"."orderId" IS NOT NULL AND "Purchase"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Purchase_date_idx" ON "Purchase" USING btree ("date");--> statement-breakpoint
CREATE INDEX "Purchase_orderId_gin_idx" ON "Purchase" USING gin ("orderId" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Purchase_displayLabel_gin_idx" ON "Purchase" USING gin ("displayLabel" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Purchase_vendorId_idx" ON "Purchase" USING btree ("vendorId");--> statement-breakpoint
CREATE INDEX "Purchase_vendorAccountId_idx" ON "Purchase" USING btree ("vendorAccountId");--> statement-breakpoint
CREATE INDEX "Purchase_defaultProjectId_idx" ON "Purchase" USING btree ("defaultProjectId");--> statement-breakpoint
CREATE INDEX "Purchase_runId_idx" ON "Purchase" USING btree ("runId");--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_shortcode_unique" ON "Recipe" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_name_key" ON "Recipe" USING btree ("name") WHERE "Recipe"."deletedAt" IS NULL AND "Recipe"."sourceType" IS DISTINCT FROM 'Book' AND "Recipe"."sourceType" IS DISTINCT FROM 'Notion';--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_cookbookId_name_key" ON "Recipe" USING btree ("cookbookId","name") WHERE "Recipe"."cookbookId" IS NOT NULL AND "Recipe"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Recipe_sourceType_idx" ON "Recipe" USING btree ("sourceType");--> statement-breakpoint
CREATE INDEX "Recipe_created_at_desc_idx" ON "Recipe" USING btree ("createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "Recipe_name_active_idx" ON "Recipe" USING btree ("name") WHERE "Recipe"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Recipe_totals_stale_idx" ON "Recipe" USING btree ("totalsComputedAt") WHERE "Recipe"."totalsComputedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Recipe_cookbookId_idx" ON "Recipe" USING btree ("cookbookId");--> statement-breakpoint
CREATE INDEX "Recipe_forkedFromRecipeId_idx" ON "Recipe" USING btree ("forkedFromRecipeId");--> statement-breakpoint
CREATE UNIQUE INDEX "Run_shortcode_unique" ON "Run" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Run_party_started_idx" ON "Run" USING btree ("ledgerPartyId","startedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "Run_vendorAccount_started_idx" ON "Run" USING btree ("vendorAccountId","startedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "Run_clientKey_unique" ON "Run" USING btree ("clientKey") WHERE "Run"."clientKey" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Run_dispatch_event_unique" ON "Run" USING btree ("dispatchEventId") WHERE "Run"."dispatchEventId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Run_one_active_vendor_account_key" ON "Run" USING btree ("vendorAccountId") WHERE "Run"."vendorAccountId" IS NOT NULL AND "Run"."status" IN ('running', 'paused_auth', 'paused_offline', 'paused_approval');--> statement-breakpoint
CREATE UNIQUE INDEX "Task_shortcode_unique" ON "Task" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Task_status_idx" ON "Task" USING btree ("status");--> statement-breakpoint
CREATE INDEX "Task_dueDate_idx" ON "Task" USING btree ("dueDate");--> statement-breakpoint
CREATE INDEX "Task_projectId_idx" ON "Task" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "Task_subjectProductId_idx" ON "Task" USING btree ("subjectProductId");--> statement-breakpoint
CREATE INDEX "Task_parentTaskId_idx" ON "Task" USING btree ("parentTaskId");--> statement-breakpoint
CREATE UNIQUE INDEX "Vendor_shortcode_unique" ON "Vendor" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor" USING btree ("name") WHERE "Vendor"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "VendorAccount_shortcode_unique" ON "VendorAccount" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "VendorAccount_vendor_member_key" ON "VendorAccount" USING btree ("vendorId","ledgerPartyId") WHERE "VendorAccount"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "VendorAccount_vendorId_idx" ON "VendorAccount" USING btree ("vendorId");--> statement-breakpoint
CREATE INDEX "VendorAccount_ledgerPartyId_idx" ON "VendorAccount" USING btree ("ledgerPartyId");--> statement-breakpoint
CREATE UNIQUE INDEX "Wish_shortcode_unique" ON "Wish" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Wish_createdAt_idx" ON "Wish" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Wish_acquiredAt_idx" ON "Wish" USING btree ("acquiredAt");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "entity_identity_on_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "Entity" ("id", "kind", "shortcode", "createdAt", "deletedAt")
  VALUES (NEW."id", TG_ARGV[0], NEW."shortcode", NEW."createdAt", NEW."deletedAt");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "entity_identity_on_soft_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Entity" SET "deletedAt" = NEW."deletedAt" WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "entity_identity_on_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Entity"
  SET "deletedAt" = COALESCE("deletedAt", OLD."deletedAt", now())
  WHERE "id" = OLD."id";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Cookbook"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('cookbook');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Cookbook"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Cookbook"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Device"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('device');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Device"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Device"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('expense');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Expense"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "FinancialAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('financialAccount');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "FinancialAccount"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "FinancialAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "FinancialTransaction"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('financialTransaction');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "FinancialTransaction"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "FinancialTransaction"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "GardenEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('gardenEntry');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "GardenEntry"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "GardenEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Image"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('image');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Image"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Image"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Ingredient"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ingredient');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Ingredient"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Ingredient"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('inventory');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "InventoryEntry"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "LedgerParty"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ledgerParty');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "LedgerParty"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "LedgerParty"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "LedgerTransfer"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ledgerTransfer');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "LedgerTransfer"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "LedgerTransfer"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('location');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Location"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Meal"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('meal');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Meal"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Meal"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Plant"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('plant');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Plant"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Plant"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('planting');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Planting"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('product');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Product"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('productCategory');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "ProductCategory"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('project');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Project"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Purchase"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('purchase');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Purchase"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Purchase"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Recipe"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('recipe');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Recipe"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Recipe"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Run"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('run');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Run"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Run"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Task"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('task');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Task"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Vendor"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('vendor');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Vendor"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Vendor"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "VendorAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('vendorAccount');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "VendorAccount"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "VendorAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Wish"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('wish');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Wish"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Wish"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE FUNCTION "entity_link_require_live_endpoints"() RETURNS trigger
LANGUAGE plpgsql AS $$
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

DROP TRIGGER IF EXISTS "EntityLink_live_endpoints" ON "EntityLink";
CREATE CONSTRAINT TRIGGER "EntityLink_live_endpoints" AFTER INSERT OR UPDATE ON "EntityLink"
  FOR EACH ROW WHEN (NEW."deletedAt" IS NULL)
  EXECUTE FUNCTION "entity_link_require_live_endpoints"();

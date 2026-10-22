ALTER TABLE "StatementRow" DROP CONSTRAINT "StatementRow_externalId_format_check";--> statement-breakpoint
ALTER TABLE "StatementImport" ADD COLUMN "observedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "StatementImport" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
ALTER TABLE "StatementImport" ADD COLUMN "completedAt" timestamp;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "chargeKey" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "withdrawnAt" timestamp;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "lastObservedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "providerAccountId" text;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "providerData" jsonb;--> statement-breakpoint
DROP INDEX "StatementRow_source_charge_idx";--> statement-breakpoint
CREATE INDEX "StatementRow_source_charge_idx" ON "StatementRow" USING btree ("source","chargeKey");--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_externalId_format_check" CHECK ("StatementRow"."externalId" ~ '^v[123]:[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "withdrawalImportId" uuid;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_withdrawalImportId_StatementImport_id_fk" FOREIGN KEY ("withdrawalImportId") REFERENCES "public"."StatementImport"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "legacyReference" text;
--> statement-breakpoint
-- First ownership was previously a membership fallback. Preserve it before
-- making collection membership authoritative; no old collection is declared complete.
INSERT INTO "StatementImportRow" ("importId", "statementRowId")
SELECT "batchId", id FROM "StatementRow"
ON CONFLICT ("importId", "statementRowId") DO NOTHING;
--> statement-breakpoint
UPDATE "StatementImport" SET "observedAt" = "createdAt";
--> statement-breakpoint
-- Provider IDs establish source-record identity; ID-less retained occurrences
-- stay independent unless an existing membership points to the very same row.
WITH positioned AS (
  SELECT r.id, r.source, r."externalId", r."providerTransactionId", r."accountDescriptor",
    COALESCE(r."legacyExternalId", r."externalId") AS legacy,
    i."createdAt" AS observed
  FROM "StatementRow" r JOIN "StatementImport" i ON i.id = r."batchId"
), identities AS (
  SELECT *, CASE WHEN "providerTransactionId" IS NOT NULL THEN
    'provider:' || encode(sha256(convert_to('[' || to_json(source)::text || ',' ||
      to_json("accountDescriptor")::text || ',' || to_json("providerTransactionId")::text || ']', 'UTF8')), 'hex')
    ELSE "externalId" END AS key
  FROM positioned
)
UPDATE "StatementRow" r SET "chargeKey" = i.key, "lastObservedAt" = i.observed
FROM identities i WHERE i.id = r.id;
--> statement-breakpoint
WITH heads AS (
  SELECT id, row_number() OVER (PARTITION BY source, "chargeKey"
    ORDER BY "lastObservedAt" DESC, "createdAt" DESC, id DESC) AS rank
  FROM "StatementRow" WHERE "deletedAt" IS NULL
)
UPDATE "StatementRow" r SET current = heads.rank = 1 FROM heads WHERE heads.id = r.id;

--> statement-breakpoint
-- Resolve the historical v1 link to one explicit charge, preserving the alias
-- without propagating its old content-based decision to coexisting charges.
WITH owners AS (
  SELECT DISTINCT ON (source, COALESCE("legacyExternalId", "externalId"))
    source, COALESCE("legacyExternalId", "externalId") AS legacy, "chargeKey"
  FROM "StatementRow" WHERE "deletedAt" IS NULL
  ORDER BY source, COALESCE("legacyExternalId", "externalId"),
    "rowPosition" NULLS FIRST, "createdAt", id
)
UPDATE "StatementRow" r SET "legacyReference" = owners.legacy
FROM owners WHERE r.source=owners.source AND r."chargeKey"=owners."chargeKey"
  AND COALESCE(r."legacyExternalId", r."externalId")=owners.legacy;

--> statement-breakpoint
-- Immutable Assessments retain their original subject and automatic receipts.
-- Move only their review ownership projection; suppression is consulted across
-- active and inactive history, and old pending advice must be regenerated.
UPDATE "AssessmentState" s SET active=false
FROM "StatementRow" r WHERE s.family='statement_transaction' AND s."recordId"=r.id
  AND s.data->>'chargeKey' IS DISTINCT FROM r."chargeKey";
--> statement-breakpoint
UPDATE "AssessmentState" s SET data=jsonb_set(COALESCE(s.data, '{}'::jsonb), '{chargeKey}', to_jsonb(r."chargeKey"))
FROM "StatementRow" r WHERE s.family='statement_transaction' AND s."recordId"=r.id
  AND s.data->>'chargeKey' IS DISTINCT FROM r."chargeKey";

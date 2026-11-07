LOCK TABLE "StatementRow", "StatementImport", "StatementImportRow" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "StatementRow" RENAME TO "SourceTransactionRecord";--> statement-breakpoint
ALTER TABLE "StatementImport" RENAME TO "TransactionImport";--> statement-breakpoint
ALTER TABLE "StatementImportRow" RENAME TO "TransactionImportRecord";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" RENAME CONSTRAINT "StatementRow_pkey" TO "SourceTransactionRecord_pkey";
--> statement-breakpoint
ALTER TABLE "TransactionImport" RENAME CONSTRAINT "StatementImport_pkey" TO "TransactionImport_pkey";
--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";--> statement-breakpoint
ALTER TABLE "TransactionImport" DROP CONSTRAINT "StatementImport_source_slug_check";--> statement-breakpoint
ALTER TABLE "TransactionImport" DROP CONSTRAINT "StatementImport_dateKind_check";--> statement-breakpoint
ALTER TABLE "TransactionImport" DROP CONSTRAINT "StatementImport_rowCountDeclared_check";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_position_check";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_source_slug_check";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_amount_whole_cent_check";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_providerAmount_whole_cent_check";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_providerStatus_check";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_disposition_check";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_dispositionReason_check";--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_externalId_format_check";--> statement-breakpoint
ALTER TABLE "TransactionImport" DROP CONSTRAINT "StatementImport_source_ExternalSource_slug_fk";
--> statement-breakpoint
ALTER TABLE "TransactionImportRecord" DROP CONSTRAINT "StatementImportRow_importId_StatementImport_id_fk";
--> statement-breakpoint
ALTER TABLE "TransactionImportRecord" DROP CONSTRAINT "StatementImportRow_statementRowId_StatementRow_id_fk";
--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_batchId_StatementImport_id_fk";
--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_source_ExternalSource_slug_fk";
--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_withdrawalImportId_StatementImport_id_fk";
--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_accountId_FinancialAccount_id_fk";
--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" DROP CONSTRAINT "StatementRow_supersededByRowId_StatementRow_id_fk";
--> statement-breakpoint
DROP INDEX "StatementImport_source_fingerprint_key";--> statement-breakpoint
DROP INDEX "StatementImport_source_idx";--> statement-breakpoint
DROP INDEX "StatementImportRow_import_row_key";--> statement-breakpoint
DROP INDEX "StatementImportRow_row_idx";--> statement-breakpoint
DROP INDEX "StatementRow_source_externalId_key";--> statement-breakpoint
DROP INDEX "StatementRow_batch_position_key";--> statement-breakpoint
DROP INDEX "StatementRow_source_providerTransactionId_idx";--> statement-breakpoint
DROP INDEX "StatementRow_source_charge_idx";--> statement-breakpoint
DROP INDEX "StatementRow_batchId_idx";--> statement-breakpoint
DROP INDEX "StatementRow_statementDate_idx";--> statement-breakpoint
DROP INDEX "StatementRow_worklist_idx";--> statement-breakpoint
DROP INDEX "StatementRow_account_date_amount_idx";--> statement-breakpoint
DROP INDEX "StatementRow_descriptor_date_amount_idx";--> statement-breakpoint
DROP INDEX "StatementRow_rawDescription_gin_idx";--> statement-breakpoint
ALTER TABLE "TransactionImport" ADD COLUMN "shortcode" text;--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD COLUMN "shortcode" text;--> statement-breakpoint
-- Retain every UUID and tombstone. Allocate against one materialized set of
-- reserved codes per 500-row batch rather than SELECTing for each candidate.
DO $migration$
DECLARE
  payload_table text;
  entity_kind text;
  prefix text;
  written integer;
BEGIN
  FOR payload_table, entity_kind, prefix IN VALUES
    ('TransactionImport', 'transactionImport', 'TIM-'),
    ('SourceTransactionRecord', 'sourceTransactionRecord', 'STR-')
  LOOP
    LOOP
      EXECUTE format($allocation$
        WITH retained AS MATERIALIZED (
          SELECT id, row_number() OVER (ORDER BY id) AS position
          FROM (SELECT id FROM %1$I WHERE shortcode IS NULL ORDER BY id LIMIT 500) page
        ), reserved AS MATERIALIZED (
          SELECT shortcode FROM "Entity" WHERE shortcode LIKE %2$L || '%%'
        ), candidates AS (
          SELECT ordinal, %2$L ||
            substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 923521) %% 31)::int + 1, 1) ||
            substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 29791) %% 31)::int + 1, 1) ||
            substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 961) %% 31)::int + 1, 1) ||
            substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 31) %% 31)::int + 1, 1) ||
            substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', (ordinal %% 31)::int + 1, 1) AS shortcode
          FROM generate_series(0::bigint, (SELECT count(*) FROM retained) + (SELECT count(*) FROM reserved) - 1) ordinal
        ), available AS (
          SELECT shortcode, row_number() OVER (ORDER BY ordinal) AS position
          FROM candidates WHERE NOT EXISTS (SELECT 1 FROM reserved WHERE reserved.shortcode = candidates.shortcode)
        ), promoted AS (
          UPDATE %1$I payload SET shortcode = available.shortcode
          FROM retained JOIN available USING (position)
          WHERE payload.id = retained.id
          RETURNING payload.id, payload.shortcode, payload."createdAt", payload."deletedAt"
        )
        INSERT INTO "Entity" (id, kind, shortcode, "createdAt", "deletedAt")
        SELECT id, %3$L, shortcode, "createdAt", "deletedAt" FROM promoted
      $allocation$, payload_table, prefix, entity_kind);
      GET DIAGNOSTICS written = ROW_COUNT;
      EXIT WHEN written = 0;
    END LOOP;
  END LOOP;
END $migration$;
--> statement-breakpoint
ALTER TABLE "TransactionImport" ALTER COLUMN "shortcode" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ALTER COLUMN "shortcode" SET NOT NULL;
--> statement-breakpoint
-- Rename only target type tags; judgments, fingerprints, publication keys,
-- application receipts and original source evidence remain byte-for-byte facts.
UPDATE "Assessment" SET subject = jsonb_set(subject, '{entity}', '"sourceTransactionRecord"'::jsonb)
WHERE family = 'statement_transaction' AND subject->>'entity' = 'statementRow';
--> statement-breakpoint
UPDATE "Assessment" SET projection = jsonb_set(projection, '{entity}', '"sourceTransactionRecord"'::jsonb)
WHERE family = 'statement_transaction' AND projection->>'entity' = 'statementRow';
--> statement-breakpoint
UPDATE "Feedback" SET projection = jsonb_set(projection, '{entity}', '"sourceTransactionRecord"'::jsonb)
WHERE projection->>'entity' = 'statementRow';
--> statement-breakpoint
UPDATE "AssessmentState" SET entity = 'sourceTransactionRecord' WHERE entity = 'statementRow';
--> statement-breakpoint
ALTER TABLE "TransactionImport" ADD CONSTRAINT "TransactionImport_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "TransactionImport" ADD CONSTRAINT "TransactionImport_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TransactionImportRecord" ADD CONSTRAINT "TransactionImportRecord_importId_TransactionImport_id_fk" FOREIGN KEY ("importId") REFERENCES "public"."TransactionImport"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TransactionImportRecord" ADD CONSTRAINT "TransactionImportRecord_statementRowId_SourceTransactionRecord_id_fk" FOREIGN KEY ("statementRowId") REFERENCES "public"."SourceTransactionRecord"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_batchId_TransactionImport_id_fk" FOREIGN KEY ("batchId") REFERENCES "public"."TransactionImport"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_withdrawalImportId_TransactionImport_id_fk" FOREIGN KEY ("withdrawalImportId") REFERENCES "public"."TransactionImport"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_accountId_FinancialAccount_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."FinancialAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_supersededByRowId_SourceTransactionRecord_id_fk" FOREIGN KEY ("supersededByRowId") REFERENCES "public"."SourceTransactionRecord"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "TransactionImport_shortcode_unique" ON "TransactionImport" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "TransactionImport_source_fingerprint_key" ON "TransactionImport" USING btree ("source","fingerprint") WHERE "TransactionImport"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "TransactionImport_source_idx" ON "TransactionImport" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "TransactionImportRecord_import_row_key" ON "TransactionImportRecord" USING btree ("importId","statementRowId");--> statement-breakpoint
CREATE INDEX "TransactionImportRecord_row_idx" ON "TransactionImportRecord" USING btree ("statementRowId");--> statement-breakpoint
CREATE UNIQUE INDEX "SourceTransactionRecord_shortcode_unique" ON "SourceTransactionRecord" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "SourceTransactionRecord_source_externalId_key" ON "SourceTransactionRecord" USING btree ("source","externalId") WHERE "SourceTransactionRecord"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "SourceTransactionRecord_batch_position_key" ON "SourceTransactionRecord" USING btree ("batchId","rowPosition") WHERE "SourceTransactionRecord"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_source_providerTransactionId_idx" ON "SourceTransactionRecord" USING btree ("source","providerTransactionId");--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_source_charge_idx" ON "SourceTransactionRecord" USING btree ("source","chargeKey");--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_batchId_idx" ON "SourceTransactionRecord" USING btree ("batchId");--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_statementDate_idx" ON "SourceTransactionRecord" USING btree ("statementDate");--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_worklist_idx" ON "SourceTransactionRecord" USING btree ("statementDate" DESC NULLS LAST) WHERE "SourceTransactionRecord"."deletedAt" IS NULL AND "SourceTransactionRecord"."disposition" = 'open' AND "SourceTransactionRecord"."supersededByRowId" IS NULL;--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_account_date_amount_idx" ON "SourceTransactionRecord" USING btree ("accountId","statementDate","amount");--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_descriptor_date_amount_idx" ON "SourceTransactionRecord" USING btree ("source","accountDescriptor","statementDate","providerAmount");--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_rawDescription_gin_idx" ON "SourceTransactionRecord" USING gin ("rawDescription" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_withdrawalImportId_idx" ON "SourceTransactionRecord" USING btree ("withdrawalImportId");--> statement-breakpoint
CREATE INDEX "SourceTransactionRecord_supersededByRowId_idx" ON "SourceTransactionRecord" USING btree ("supersededByRowId");--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant', 'spendingCategory', 'email', 'imageJob', 'sourceTransactionRecord', 'transactionImport'));--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' WHEN 'spendingCategory' THEN "Entity"."shortcode" LIKE 'SPC-%' WHEN 'email' THEN "Entity"."shortcode" LIKE 'EML-%' WHEN 'imageJob' THEN "Entity"."shortcode" LIKE 'IPR-%' WHEN 'sourceTransactionRecord' THEN "Entity"."shortcode" LIKE 'STR-%' WHEN 'transactionImport' THEN "Entity"."shortcode" LIKE 'TIM-%' ELSE false END);--> statement-breakpoint
ALTER TABLE "TransactionImport" ADD CONSTRAINT "TransactionImport_source_slug_check" CHECK ("TransactionImport"."source" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "TransactionImport"."source" = lower(trim("TransactionImport"."source")));--> statement-breakpoint
ALTER TABLE "TransactionImport" ADD CONSTRAINT "TransactionImport_dateKind_check" CHECK ("TransactionImport"."dateKind" IN ('posted', 'transaction', 'unknown'));--> statement-breakpoint
ALTER TABLE "TransactionImport" ADD CONSTRAINT "TransactionImport_rowCountDeclared_check" CHECK ("TransactionImport"."rowCountDeclared" IS NULL OR "TransactionImport"."rowCountDeclared" >= 0);--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_position_check" CHECK ("SourceTransactionRecord"."rowPosition" IS NULL OR "SourceTransactionRecord"."rowPosition" > 0);--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_source_slug_check" CHECK ("SourceTransactionRecord"."source" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "SourceTransactionRecord"."source" = lower(trim("SourceTransactionRecord"."source")));--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_amount_whole_cent_check" CHECK (abs("SourceTransactionRecord"."amount" * 100 - round("SourceTransactionRecord"."amount" * 100)) < 0.0000001);--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_providerAmount_whole_cent_check" CHECK (abs("SourceTransactionRecord"."providerAmount" * 100 - round("SourceTransactionRecord"."providerAmount" * 100)) < 0.0000001);--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_providerStatus_check" CHECK ("SourceTransactionRecord"."providerStatus" IS NULL OR "SourceTransactionRecord"."providerStatus" IN ('posted', 'pending'));--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_disposition_check" CHECK (("SourceTransactionRecord"."disposition" = 'open' AND "SourceTransactionRecord"."dispositionReason" IS NULL AND "SourceTransactionRecord"."dispositionNote" IS NULL)
          OR ("SourceTransactionRecord"."disposition" = 'ignored' AND "SourceTransactionRecord"."dispositionReason" IS NOT NULL AND "SourceTransactionRecord"."dispositionNote" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_dispositionReason_check" CHECK ("SourceTransactionRecord"."dispositionReason" IS NULL OR "SourceTransactionRecord"."dispositionReason" IN
          ('not_modeled', 'not_a_purchase', 'duplicate_of_other_source', 'pre_cubby', 'other'));--> statement-breakpoint
ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_externalId_format_check" CHECK ("SourceTransactionRecord"."externalId" ~ '^v[123]:[0-9a-f]{64}$');
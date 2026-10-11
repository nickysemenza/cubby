CREATE TABLE "StatementImportRow" (
	"importId" uuid NOT NULL,
	"statementRowId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "StatementImportRow" ADD CONSTRAINT "StatementImportRow_importId_StatementImport_id_fk" FOREIGN KEY ("importId") REFERENCES "public"."StatementImport"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StatementImportRow" ADD CONSTRAINT "StatementImportRow_statementRowId_StatementRow_id_fk" FOREIGN KEY ("statementRowId") REFERENCES "public"."StatementRow"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "StatementImportRow_import_row_key" ON "StatementImportRow" USING btree ("importId","statementRowId");--> statement-breakpoint
CREATE INDEX "StatementImportRow_row_idx" ON "StatementImportRow" USING btree ("statementRowId");
--> statement-breakpoint
-- The first-ingesting batch is authentic membership evidence. Other exports
-- require original-source replay; present rows cannot reconstruct their roster.
INSERT INTO "StatementImportRow" ("importId", "statementRowId", "createdAt")
SELECT "batchId", id, "createdAt" FROM "StatementRow"
ON CONFLICT ("importId", "statementRowId") DO NOTHING;

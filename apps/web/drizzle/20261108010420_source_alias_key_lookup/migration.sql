DROP INDEX "FinancialEvidenceAlias_lookup_idx";--> statement-breakpoint
CREATE INDEX "FinancialEvidenceAlias_lookup_idx" ON "FinancialEvidenceAlias" ("source","value");
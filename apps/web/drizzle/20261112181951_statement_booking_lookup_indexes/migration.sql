-- Small tables: plain CREATE INDEX holds SHARE locks for well under a second.
-- Take every lock first in a fixed order; bounded acquisition lets the runner
-- retry a lock timeout instead of queueing behind long writers.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE "FinancialTransaction", "PurchasePaymentEvidence", "Vendor" IN SHARE MODE;--> statement-breakpoint
CREATE INDEX "FinancialTransaction_accountId_postedDate_idx" ON "FinancialTransaction" ("accountId","postedDate") WHERE "deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "FinancialTransaction_accountId_transactionDate_idx" ON "FinancialTransaction" ("accountId","transactionDate") WHERE "deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "PurchasePaymentEvidence_charged_day_amount_idx" ON "PurchasePaymentEvidence" (("chargedAt"::date),"amountMinor");--> statement-breakpoint
CREATE INDEX "Vendor_lower_name_live_idx" ON "Vendor" (lower("name")) WHERE "deletedAt" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION name_match_keys(names text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT coalesce(array_agg(lower(value)), ARRAY[]::text[]) FROM unnest(names) AS n(value)
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Vendor_alias_keys_live_idx"
  ON "Vendor" USING gin(name_match_keys(aliases)) WITH (fastupdate = off)
  WHERE "deletedAt" IS NULL;

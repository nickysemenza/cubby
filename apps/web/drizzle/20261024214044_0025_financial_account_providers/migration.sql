ALTER TABLE "FinancialAccount" DROP CONSTRAINT "FinancialAccount_providerVendor_stored_value_check";--> statement-breakpoint
DROP INDEX "FinancialAccount_provider_owner_key";--> statement-breakpoint
CREATE INDEX "FinancialAccount_providerVendorId_ledgerPartyId_idx" ON "FinancialAccount" USING btree ("providerVendorId","ledgerPartyId");--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_provider_non_cash_check" CHECK ("FinancialAccount"."providerVendorId" IS NULL OR "FinancialAccount"."identity"->>'kind' <> 'cash');
--> statement-breakpoint
-- Preserve retired identity evidence and proposal history before removing duplicate keys.
LOCK TABLE "FinancialAccount", "AssessmentState" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
UPDATE "FinancialAccount"
SET notes = concat_ws(E'\n\n', nullif(notes, ''),
    'Previous provider identity: ' || jsonb_strip_nulls(jsonb_build_object(
      'issuer', identity->'issuer', 'institution', identity->'institution',
      'provider', identity->'provider'))::text)
WHERE jsonb_strip_nulls(jsonb_build_object(
  'issuer', identity->'issuer', 'institution', identity->'institution',
  'provider', identity->'provider')) <> '{}'::jsonb;
--> statement-breakpoint
UPDATE "FinancialAccount"
SET identity = identity - ARRAY['issuer', 'institution', 'provider']::text[]
WHERE identity ?| ARRAY['issuer', 'institution', 'provider'];
--> statement-breakpoint
-- Old text proposals cannot be applied as Vendor references. Retain all history.
UPDATE "AssessmentState" SET active = false,
  status = CASE WHEN status = 'pending' THEN 'superseded' ELSE status END,
  "updatedAt" = now()
WHERE entity = 'financialAccount' AND field = 'issuer';

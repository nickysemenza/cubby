-- Fence old writers through the copy/drop transaction.
LOCK TABLE "MerchantVendorRule", "FinancialTransactionAllocation", "FinancialTransaction", "Purchase", "Vendor", "AuditLog" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "FinancialTransactionAllocation" ADD COLUMN "confirmsMerchant" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Member/API/MCP allocations outside unattended Runs are independent history.
-- Missing or unattended provenance stays unconfirmed rather than teaching guesses.
UPDATE "FinancialTransactionAllocation" allocation
SET "confirmsMerchant" = COALESCE((
  SELECT audit.channel <> 'system' AND audit."runId" IS NULL
  FROM "AuditLog" audit
  WHERE audit."entityKind" = 'financialTransaction'
    AND audit."entityId" = allocation."transactionId"
    AND audit.changes ? 'allocations'
  ORDER BY audit."createdAt" DESC, audit.id DESC
  LIMIT 1
), false);
--> statement-breakpoint
-- A saved rule independently confirms any existing matching allocation.
UPDATE "FinancialTransactionAllocation" allocation
SET "confirmsMerchant" = true
FROM "FinancialTransaction" ft, "Purchase" purchase, "MerchantVendorRule" rule
WHERE ft.id = allocation."transactionId"
  AND purchase.id = allocation."purchaseId"
  AND purchase."vendorId" = rule."vendorId"
  AND btrim(regexp_replace(lower(ft.merchant), '\s+', ' ', 'g')) = rule."normalizedMerchant";
--> statement-breakpoint
DROP TABLE "MerchantVendorRule";

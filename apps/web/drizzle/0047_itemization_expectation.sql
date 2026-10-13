-- Breaking cutover: the policy decides whether a Purchase should be itemized,
-- not whether a receipt exists, so its name says so. Values are unchanged;
-- every stored reference to the old name moves with the column.
ALTER TABLE "Vendor" RENAME COLUMN "evidenceExpectation" TO "itemizationExpectation";--> statement-breakpoint
ALTER TABLE "SpendingCategory" RENAME COLUMN "evidenceExpectation" TO "itemizationExpectation";--> statement-breakpoint
ALTER TABLE "SpendingCategory" RENAME CONSTRAINT "SpendingCategory_evidenceExpectation_check" TO "SpendingCategory_itemizationExpectation_check";--> statement-breakpoint
ALTER TABLE "Purchase" RENAME COLUMN "evidenceExpectation" TO "itemizationExpectation";--> statement-breakpoint
ALTER TABLE "FinancialTransaction" RENAME COLUMN "evidenceExpectation" TO "itemizationExpectation";--> statement-breakpoint
UPDATE "Suggestion" SET "field" = 'itemizationExpectation' WHERE "field" = 'evidenceExpectation';--> statement-breakpoint
UPDATE "EntitySource" SET "fieldPath" = 'itemizationExpectation' WHERE "fieldPath" = 'evidenceExpectation';--> statement-breakpoint
UPDATE "DataException" SET "check" = replace("check", '_evidence_expectation', '_itemization_expectation')
WHERE "check" IN ('purchase_evidence_expectation', 'financial_transaction_evidence_expectation', 'spending_category_evidence_expectation');--> statement-breakpoint
-- Audit readers return stored diffs verbatim; the four renamed entities keep
-- flat field diffs (only Image nests), so history moves to the live key.
UPDATE "AuditLog"
SET "changes" = ("changes" - 'evidenceExpectation') || jsonb_build_object('itemizationExpectation', "changes"->'evidenceExpectation')
WHERE "entityKind" IN ('vendor', 'spendingCategory', 'purchase', 'financialTransaction')
  AND "changes" ? 'evidenceExpectation';

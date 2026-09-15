-- Run only after the application version containing persistedInvariantViolations
-- is deployed and its live audit returns zero. The operator owns the production
-- schema exclusively for the transaction and the immediate readback.

BEGIN;

ALTER TABLE "MealRecipe"
  DROP CONSTRAINT "MealRecipe_estimatedYieldGrams_check",
  DROP CONSTRAINT "MealRecipe_actualYieldGrams_check";
ALTER TABLE "MealRecipePortion"
  DROP CONSTRAINT "MealRecipePortion_grams_check",
  DROP CONSTRAINT "MealRecipePortion_amount_source_check";
ALTER TABLE "MealFoodEntry"
  DROP CONSTRAINT "MealFoodEntry_grams_check",
  DROP CONSTRAINT "MealFoodEntry_amount_compatibility_check",
  DROP CONSTRAINT "MealFoodEntry_source_check";
ALTER TABLE "Location" DROP CONSTRAINT "Location_productId_type_check";
ALTER TABLE "Image" DROP CONSTRAINT "Image_perceptualHash_format_check";
ALTER TABLE "PlantingLocationPeriod"
  DROP CONSTRAINT "PlantingLocationPeriod_startKind_check";
ALTER TABLE "ProjectDependency"
  DROP CONSTRAINT "ProjectDependency_no_self_check";
ALTER TABLE "TaskDependency"
  DROP CONSTRAINT "TaskDependency_no_self_check";
ALTER TABLE "LedgerParty" DROP CONSTRAINT "LedgerParty_kind_check";
ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_statedTotal_whole_cent_check";
ALTER TABLE "ProductComponent"
  DROP CONSTRAINT "ProductComponent_quantity_check",
  DROP CONSTRAINT "ProductComponent_not_self_check";
ALTER TABLE "FinancialTransaction"
  DROP CONSTRAINT "FinancialTransaction_amount_whole_cent_check",
  DROP CONSTRAINT "FinancialTransaction_posted_date_check";
ALTER TABLE "FinancialTransactionAllocation"
  DROP CONSTRAINT "FinancialTransactionAllocation_amount_whole_cent_check";
ALTER TABLE "LedgerTransfer"
  DROP CONSTRAINT "LedgerTransfer_amount_whole_cent_check";
ALTER TABLE "StatementImport"
  DROP CONSTRAINT "StatementImport_dateKind_check",
  DROP CONSTRAINT "StatementImport_rowCountDeclared_check";
ALTER TABLE "StatementRow"
  DROP CONSTRAINT "StatementRow_amount_whole_cent_check",
  DROP CONSTRAINT "StatementRow_providerAmount_whole_cent_check",
  DROP CONSTRAINT "StatementRow_providerStatus_check",
  DROP CONSTRAINT "StatementRow_disposition_check",
  DROP CONSTRAINT "StatementRow_dispositionReason_check";
ALTER TABLE "Expense"
  DROP CONSTRAINT "Expense_cost_whole_cent_check",
  DROP CONSTRAINT "Expense_productQuantity_check",
  DROP CONSTRAINT "Expense_lineKind_productId_check";
ALTER TABLE "ExpenseAttribution"
  DROP CONSTRAINT "ExpenseAttribution_role_check",
  DROP CONSTRAINT "ExpenseAttribution_weight_check";
ALTER TABLE "LedgerSourceClaim"
  DROP CONSTRAINT "LedgerSourceClaim_owner_check",
  DROP CONSTRAINT "LedgerSourceClaim_sourceKeyVersion_check",
  DROP CONSTRAINT "LedgerSourceClaim_reconciliation_check";

DO $$
DECLARE
  actual text[];
  expected constant text[] := ARRAY[
    'LedgerSourceClaim_source_check',
    'MealFoodEntry_amount_check',
    'MealRecipePortion_amount_check',
    'ProductExternalId_gtin_digits_check',
    'ProductExternalId_source_slug_check',
    'StatementImport_source_slug_check',
    'StatementRow_externalId_format_check',
    'StatementRow_source_slug_check'
  ];
BEGIN
  SELECT array_agg(conname ORDER BY conname) INTO actual
  FROM pg_constraint
  WHERE contype = 'c' AND connamespace = 'public'::regnamespace;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'CHECK firewall mismatch after pruning: %', actual;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'c'
      AND connamespace = 'public'::regnamespace
      AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'An unvalidated CHECK remains after pruning';
  END IF;
END $$;

COMMIT;

-- Immediately afterward, from apps/web:
--   pnpm db:verify-checks

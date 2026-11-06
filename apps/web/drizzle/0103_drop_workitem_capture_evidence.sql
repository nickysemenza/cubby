-- cubby:transaction-per-statement
-- See 0073 for how this mode behaves against live writers.
-- This is one statement, so one transaction: its locks are taken before its checks and held
-- through its drops, and a lock timeout rolls everything back for the runner to retry. Each
-- table is tested for existence, so a rerun after a commit whose receipt was lost is a no-op.
--
-- WorkItem and JobInvalidationCapture only scheduled derived recomputation. Nothing reads the
-- tickets now, and the hourly pass or a SQL view recomputes every declared target regardless, so
-- a ticket for a declared target owes nothing. Any other ticket stops this. PhotoGroupSourceEvidence
-- lost its last writer earlier and holds no rows. Anything else in these tables stops this.
DO $$
DECLARE
  retired text;
BEGIN
  FOREACH retired IN ARRAY ARRAY['JobInvalidationCapture', 'PhotoGroupSourceEvidence', 'WorkItem'] LOOP
    IF to_regclass(format('public.%I', retired)) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', retired);
    END IF;
  END LOOP;

  -- Nested, not AND: one expression is planned whole, and a missing table fails its planning.
  IF to_regclass('public."JobInvalidationCapture"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "JobInvalidationCapture" WHERE key <> 'derived:drain') THEN
      RAISE EXCEPTION 'JobInvalidationCapture holds rows of another Job';
    END IF;
  END IF;
  IF to_regclass('public."PhotoGroupSourceEvidence"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "PhotoGroupSourceEvidence") THEN
      RAISE EXCEPTION 'PhotoGroupSourceEvidence holds rows';
    END IF;
  END IF;

  IF to_regclass('public."WorkItem"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "WorkItem" WHERE drain <> 'derived:drain') THEN
      RAISE EXCEPTION 'WorkItem holds rows of another drain';
    END IF;
    -- A target is `<entity>.<key>`, or `<entity>.<key>@<column>` for an old fanout mark.
    IF EXISTS (
      SELECT 1 FROM "WorkItem" WHERE split_part(target, '@', 1) <> ALL (ARRAY[
      'cookbook.dataQuality',
      'cookbook.searchDocument',
      'device.dataQuality',
      'email.dataQuality',
      'email.relationshipFacts',
      'expense.beneficiaryResult',
      'expense.dataQuality',
      'expense.searchDocument',
      'financialAccount.dataQuality',
      'financialAccount.searchDocument',
      'financialTransaction.dataQuality',
      'financialTransaction.searchDocument',
      'gardenEntry.dataQuality',
      'gardenEntry.searchDocument',
      'image.dataQuality',
      'image.searchDocument',
      'imageJob.dataQuality',
      'ingredient.dataQuality',
      'ingredient.searchDocument',
      'inventory.dataQuality',
      'inventory.ownership',
      'inventory.searchDocument',
      'inventory.valuation',
      'ledgerParty.dataQuality',
      'ledgerTransfer.dataQuality',
      'location.dataQuality',
      'location.searchDocument',
      'location.valuationRollup',
      'meal.dataQuality',
      'meal.searchDocument',
      'plant.dataQuality',
      'plant.searchDocument',
      'planting.dataQuality',
      'planting.searchDocument',
      'product.conversionCoverage',
      'product.cost',
      'product.dataQuality',
      'product.food',
      'product.ledgerExpectedQuantity',
      'product.ownership',
      'product.price',
      'product.quantityVariance',
      'product.readFacts',
      'product.searchDocument',
      'productCategory.dataQuality',
      'project.completionYear',
      'project.dataQuality',
      'project.rollups',
      'project.searchDocument',
      'project.startDate',
      'project.workDiagnosticFacts',
      'purchase.dataQuality',
      'purchase.searchDocument',
      'recipe.dataQuality',
      'recipe.searchDocument',
      'recipe.totals',
      'run.dataQuality',
      'shipment.dataQuality',
      'shipment.eventSummary',
      'shipment.searchDocument',
      'sourceTransactionRecord.searchDocument',
      'spendingCategory.dataQuality',
      'task.dataQuality',
      'task.searchDocument',
      'transactionImport.searchDocument',
      'vendor.dataQuality',
      'vendor.searchDocument',
      'wish.dataQuality',
      'wish.searchDocument'
      ])
    ) THEN
      RAISE EXCEPTION 'WorkItem holds a ticket for a target that is not declared';
    END IF;
  END IF;

  DROP TABLE IF EXISTS "JobInvalidationCapture";
  DROP TABLE IF EXISTS "PhotoGroupSourceEvidence";
  DROP TABLE IF EXISTS "WorkItem";
  DROP SEQUENCE IF EXISTS "public"."WorkTicket";
END $$;

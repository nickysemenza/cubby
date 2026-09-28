-- Post-check: every global invariant snapshotted by 00-guard must hold after
-- all slices ran. Slice-specific checks live at the end of each fragment.
DO $$
DECLARE
  drift text;
BEGIN
  -- All money lives on Expense: spend per month, live and deleted, is untouched.
  SELECT string_agg(coalesce(pre."month", post."month")::text, ', ')
  INTO drift
  FROM "_cleanup_pre_money" pre
  FULL JOIN (
    SELECT date_trunc('month', "date") AS "month", ("deletedAt" IS NULL) AS "live",
      count(*) AS "lines", coalesce(sum("cost"), 0) AS "cost"
    FROM "Expense" GROUP BY 1, 2
  ) post USING ("month", "live")
  WHERE pre."lines" IS DISTINCT FROM post."lines"
     OR pre."cost" IS DISTINCT FROM post."cost";
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup changed Expense spend for months: %', drift;
  END IF;

  -- Tables no slice may add or remove rows from.
  SELECT string_agg(pre."table" || ' ' || pre."rows" || '->' || post."rows", ', ')
  INTO drift
  FROM "_cleanup_pre_counts" pre
  JOIN (
    SELECT 'Expense' AS "table", count(*) AS "rows" FROM "Expense"
    UNION ALL SELECT 'Purchase', count(*) FROM "Purchase"
    UNION ALL SELECT 'Vendor', count(*) FROM "Vendor"
    UNION ALL SELECT 'FinancialAccount', count(*) FROM "FinancialAccount"
    UNION ALL SELECT 'FinancialTransaction', count(*) FROM "FinancialTransaction"
    UNION ALL SELECT 'FinancialTransactionAllocation', count(*) FROM "FinancialTransactionAllocation"
    UNION ALL SELECT 'StatementRow', count(*) FROM "StatementRow"
    UNION ALL SELECT 'Product', count(*) FROM "Product"
    UNION ALL SELECT 'Ingredient', count(*) FROM "Ingredient"
    UNION ALL SELECT 'Recipe', count(*) FROM "Recipe"
    UNION ALL SELECT 'RecipeSectionIngredient', count(*) FROM "RecipeSectionIngredient"
    UNION ALL SELECT 'Location', count(*) FROM "Location"
    UNION ALL SELECT 'InventoryEntry', count(*) FROM "InventoryEntry"
    UNION ALL SELECT 'Project', count(*) FROM "Project"
    UNION ALL SELECT 'Task', count(*) FROM "Task"
    UNION ALL SELECT 'Image', count(*) FROM "Image"
    UNION ALL SELECT 'EntityAttachment', count(*) FROM "EntityAttachment"
    UNION ALL SELECT 'AiUsage', count(*) FROM "AiUsage"
  ) post USING ("table")
  WHERE pre."rows" <> post."rows";
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup changed row counts: %', drift;
  END IF;

  -- Entity identities change only for the two kinds the cleanup retires rows
  -- of: imageSighting (demoted) and run (throwaway AI runs consolidated).
  SELECT string_agg(coalesce(pre."kind", post."kind"), ', ')
  INTO drift
  FROM "_cleanup_pre_entities" pre
  FULL JOIN (
    SELECT "kind", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live"
    FROM "Entity" GROUP BY 1
  ) post USING ("kind")
  WHERE coalesce(pre."kind", post."kind") NOT IN ('imageSighting', 'run')
    AND (pre."rows" IS DISTINCT FROM post."rows" OR pre."live" IS DISTINCT FROM post."live");
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup changed Entity identities for kinds: %', drift;
  END IF;

  -- Every constraint the transform added or re-added is validated.
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ')
  INTO drift
  FROM pg_constraint
  WHERE NOT convalidated AND connamespace = 'public'::regnamespace;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup left unvalidated constraints: %', drift;
  END IF;
END $$;

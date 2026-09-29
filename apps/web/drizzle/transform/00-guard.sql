-- Guard: snapshot the invariants the whole cleanup must preserve, before any
-- slice runs. Everything here is relative (compared again in 90-post-check),
-- so it holds on an empty test database and on production alike. Absolute
-- production expectations live in the external verification script.
CREATE TEMP TABLE "_cleanup_pre_money" ON COMMIT DROP AS
SELECT
  coalesce(date_trunc('month', "date"), '-infinity') AS "month",
  ("deletedAt" IS NULL) AS "live",
  count(*) AS "lines",
  -- numeric, not the double precision column: a float sum's value depends on
  -- scan order (parallel aggregates), which would false-fail the post-check.
  coalesce(sum("cost"::numeric), 0) AS "cost"
FROM "Expense"
GROUP BY 1, 2;
--> statement-breakpoint
CREATE TEMP TABLE "_cleanup_pre_counts" ON COMMIT DROP AS
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
UNION ALL SELECT 'AiUsage', count(*) FROM "AiUsage";
--> statement-breakpoint
CREATE TEMP TABLE "_cleanup_pre_entities" ON COMMIT DROP AS
SELECT "kind", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live"
FROM "Entity"
GROUP BY 1;

-- Re-evaluate retained principal items through the existing derived-data drain.
-- Source rows, category intent, evidence and member exceptions are unchanged.
SET LOCAL cubby.derived_priority = '1';
--> statement-breakpoint
SELECT derived_mark('expense.dataQuality', ARRAY(
  SELECT id FROM "Expense"
  WHERE "deletedAt" IS NULL AND "productId" IS NULL
    AND "economicRole" = 'vendor' AND "lineKind" = 'principal'
    AND "lineBasis" = 'item_line' AND "costType" <> 'services'
));
--> statement-breakpoint
SELECT derived_mark('purchase.dataQuality', ARRAY(
  SELECT DISTINCT p.id FROM "Purchase" p
  JOIN "Expense" e ON e."purchaseId" = p.id AND e."deletedAt" IS NULL
  WHERE p."deletedAt" IS NULL AND e."productId" IS NULL
    AND e."economicRole" = 'vendor' AND e."lineKind" = 'principal'
    AND e."lineBasis" = 'item_line' AND e."costType" <> 'services'
));

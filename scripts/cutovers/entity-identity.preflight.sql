-- Durable entity identity preflight (ADR 0006). Read-only. Every query must
-- return no rows before entity-identity.sql runs; each names the data that
-- would make the cutover fail.

-- A UUID used by two entity tables would collide in Entity's primary key.
SELECT x."id", array_agg(x."kind") AS "kinds"
FROM (
  SELECT "id", 'cookbook' AS "kind" FROM "Cookbook"
  UNION ALL SELECT "id", 'device' AS "kind" FROM "Device"
  UNION ALL SELECT "id", 'expense' AS "kind" FROM "Expense"
  UNION ALL SELECT "id", 'financialAccount' AS "kind" FROM "FinancialAccount"
  UNION ALL SELECT "id", 'financialTransaction' AS "kind" FROM "FinancialTransaction"
  UNION ALL SELECT "id", 'gardenEntry' AS "kind" FROM "GardenEntry"
  UNION ALL SELECT "id", 'image' AS "kind" FROM "Image"
  UNION ALL SELECT "id", 'imageSighting' AS "kind" FROM "ImageSighting"
  UNION ALL SELECT "id", 'importRun' AS "kind" FROM "ImportRun"
  UNION ALL SELECT "id", 'ingredient' AS "kind" FROM "Ingredient"
  UNION ALL SELECT "id", 'inventory' AS "kind" FROM "InventoryEntry"
  UNION ALL SELECT "id", 'ledgerParty' AS "kind" FROM "LedgerParty"
  UNION ALL SELECT "id", 'ledgerTransfer' AS "kind" FROM "LedgerTransfer"
  UNION ALL SELECT "id", 'location' AS "kind" FROM "Location"
  UNION ALL SELECT "id", 'meal' AS "kind" FROM "Meal"
  UNION ALL SELECT "id", 'plant' AS "kind" FROM "Plant"
  UNION ALL SELECT "id", 'planting' AS "kind" FROM "Planting"
  UNION ALL SELECT "id", 'product' AS "kind" FROM "Product"
  UNION ALL SELECT "id", 'productCategory' AS "kind" FROM "ProductCategory"
  UNION ALL SELECT "id", 'project' AS "kind" FROM "Project"
  UNION ALL SELECT "id", 'purchase' AS "kind" FROM "Purchase"
  UNION ALL SELECT "id", 'recipe' AS "kind" FROM "Recipe"
  UNION ALL SELECT "id", 'task' AS "kind" FROM "Task"
  UNION ALL SELECT "id", 'vendor' AS "kind" FROM "Vendor"
  UNION ALL SELECT "id", 'vendorAccount' AS "kind" FROM "VendorAccount"
  UNION ALL SELECT "id", 'wish' AS "kind" FROM "Wish"
) x
GROUP BY x."id" HAVING count(*) > 1;

-- A shortcode without its kind's prefix would fail Entity_shortcode_prefix_check.
SELECT 'cookbook' AS "kind", "shortcode" FROM "Cookbook" WHERE "shortcode" NOT LIKE 'CKB-%';
SELECT 'device' AS "kind", "shortcode" FROM "Device" WHERE "shortcode" NOT LIKE 'DEV-%';
SELECT 'expense' AS "kind", "shortcode" FROM "Expense" WHERE "shortcode" NOT LIKE 'EXP-%';
SELECT 'financialAccount' AS "kind", "shortcode" FROM "FinancialAccount" WHERE "shortcode" NOT LIKE 'FAC-%';
SELECT 'financialTransaction' AS "kind", "shortcode" FROM "FinancialTransaction" WHERE "shortcode" NOT LIKE 'FTX-%';
SELECT 'gardenEntry' AS "kind", "shortcode" FROM "GardenEntry" WHERE "shortcode" NOT LIKE 'GDE-%';
SELECT 'image' AS "kind", "shortcode" FROM "Image" WHERE "shortcode" NOT LIKE 'IMG-%';
SELECT 'imageSighting' AS "kind", "shortcode" FROM "ImageSighting" WHERE "shortcode" NOT LIKE 'IMS-%';
SELECT 'importRun' AS "kind", "shortcode" FROM "ImportRun" WHERE "shortcode" NOT LIKE 'RUN-%';
SELECT 'ingredient' AS "kind", "shortcode" FROM "Ingredient" WHERE "shortcode" NOT LIKE 'ING-%';
SELECT 'inventory' AS "kind", "shortcode" FROM "InventoryEntry" WHERE "shortcode" NOT LIKE 'INV-%';
SELECT 'ledgerParty' AS "kind", "shortcode" FROM "LedgerParty" WHERE "shortcode" NOT LIKE 'LPY-%';
SELECT 'ledgerTransfer' AS "kind", "shortcode" FROM "LedgerTransfer" WHERE "shortcode" NOT LIKE 'LTR-%';
SELECT 'location' AS "kind", "shortcode" FROM "Location" WHERE "shortcode" NOT LIKE 'LOC-%';
SELECT 'meal' AS "kind", "shortcode" FROM "Meal" WHERE "shortcode" NOT LIKE 'MEL-%';
SELECT 'plant' AS "kind", "shortcode" FROM "Plant" WHERE "shortcode" NOT LIKE 'PLANT-%';
SELECT 'planting' AS "kind", "shortcode" FROM "Planting" WHERE "shortcode" NOT LIKE 'PLT-%';
SELECT 'product' AS "kind", "shortcode" FROM "Product" WHERE "shortcode" NOT LIKE 'PRD-%';
SELECT 'productCategory' AS "kind", "shortcode" FROM "ProductCategory" WHERE "shortcode" NOT LIKE 'CAT-%';
SELECT 'project' AS "kind", "shortcode" FROM "Project" WHERE "shortcode" NOT LIKE 'PRJ-%';
SELECT 'purchase' AS "kind", "shortcode" FROM "Purchase" WHERE "shortcode" NOT LIKE 'PUR-%';
SELECT 'recipe' AS "kind", "shortcode" FROM "Recipe" WHERE "shortcode" NOT LIKE 'RCP-%';
SELECT 'task' AS "kind", "shortcode" FROM "Task" WHERE "shortcode" NOT LIKE 'TSK-%';
SELECT 'vendor' AS "kind", "shortcode" FROM "Vendor" WHERE "shortcode" NOT LIKE 'VEN-%';
SELECT 'vendorAccount' AS "kind", "shortcode" FROM "VendorAccount" WHERE "shortcode" NOT LIKE 'VACCT-%';
SELECT 'wish' AS "kind", "shortcode" FROM "Wish" WHERE "shortcode" NOT LIKE 'WSH-%';

-- A history or projection row whose kind is not an entity kind, or whose id
-- belongs to an entity of another kind, would fail its identity FK.
SELECT 'AuditLog' AS "table", a."entityType", a."entityId" FROM "AuditLog" a
WHERE a."entityType" NOT IN ('cookbook', 'device', 'expense', 'financialAccount', 'financialTransaction', 'gardenEntry', 'image', 'imageSighting', 'importRun', 'ingredient', 'inventory', 'ledgerParty', 'ledgerTransfer', 'location', 'meal', 'plant', 'planting', 'product', 'productCategory', 'project', 'purchase', 'recipe', 'task', 'vendor', 'vendorAccount', 'wish')
UNION ALL
SELECT 'SearchDocument', s."entityType", s."entityId" FROM "SearchDocument" s
WHERE s."entityType" NOT IN ('cookbook', 'device', 'expense', 'financialAccount', 'financialTransaction', 'gardenEntry', 'image', 'imageSighting', 'importRun', 'ingredient', 'inventory', 'ledgerParty', 'ledgerTransfer', 'location', 'meal', 'plant', 'planting', 'product', 'productCategory', 'project', 'purchase', 'recipe', 'task', 'vendor', 'vendorAccount', 'wish')
UNION ALL
SELECT 'EntityEmbedding', m."entityType", m."entityId" FROM "EntityEmbedding" m
WHERE m."entityType" NOT IN ('cookbook', 'device', 'expense', 'financialAccount', 'financialTransaction', 'gardenEntry', 'image', 'imageSighting', 'importRun', 'ingredient', 'inventory', 'ledgerParty', 'ledgerTransfer', 'location', 'meal', 'plant', 'planting', 'product', 'productCategory', 'project', 'purchase', 'recipe', 'task', 'vendor', 'vendorAccount', 'wish');

-- A history row naming an existing entity under another kind would fail its
-- identity FK. The cutover repairs exactly one known pattern ('inventory'
-- entries carrying a Product id); anything listed here is new and must be
-- understood first.
WITH payload AS (
  SELECT "id", 'cookbook' AS "kind" FROM "Cookbook"
  UNION ALL SELECT "id", 'device' AS "kind" FROM "Device"
  UNION ALL SELECT "id", 'expense' AS "kind" FROM "Expense"
  UNION ALL SELECT "id", 'financialAccount' AS "kind" FROM "FinancialAccount"
  UNION ALL SELECT "id", 'financialTransaction' AS "kind" FROM "FinancialTransaction"
  UNION ALL SELECT "id", 'gardenEntry' AS "kind" FROM "GardenEntry"
  UNION ALL SELECT "id", 'image' AS "kind" FROM "Image"
  UNION ALL SELECT "id", 'imageSighting' AS "kind" FROM "ImageSighting"
  UNION ALL SELECT "id", 'importRun' AS "kind" FROM "ImportRun"
  UNION ALL SELECT "id", 'ingredient' AS "kind" FROM "Ingredient"
  UNION ALL SELECT "id", 'inventory' AS "kind" FROM "InventoryEntry"
  UNION ALL SELECT "id", 'ledgerParty' AS "kind" FROM "LedgerParty"
  UNION ALL SELECT "id", 'ledgerTransfer' AS "kind" FROM "LedgerTransfer"
  UNION ALL SELECT "id", 'location' AS "kind" FROM "Location"
  UNION ALL SELECT "id", 'meal' AS "kind" FROM "Meal"
  UNION ALL SELECT "id", 'plant' AS "kind" FROM "Plant"
  UNION ALL SELECT "id", 'planting' AS "kind" FROM "Planting"
  UNION ALL SELECT "id", 'product' AS "kind" FROM "Product"
  UNION ALL SELECT "id", 'productCategory' AS "kind" FROM "ProductCategory"
  UNION ALL SELECT "id", 'project' AS "kind" FROM "Project"
  UNION ALL SELECT "id", 'purchase' AS "kind" FROM "Purchase"
  UNION ALL SELECT "id", 'recipe' AS "kind" FROM "Recipe"
  UNION ALL SELECT "id", 'task' AS "kind" FROM "Task"
  UNION ALL SELECT "id", 'vendor' AS "kind" FROM "Vendor"
  UNION ALL SELECT "id", 'vendorAccount' AS "kind" FROM "VendorAccount"
  UNION ALL SELECT "id", 'wish' AS "kind" FROM "Wish"
), history AS (
  SELECT 'AuditLog' AS "table", "entityId" AS "id", "entityType" AS "kind" FROM "AuditLog"
  UNION ALL SELECT 'SearchDocument', "entityId", "entityType" FROM "SearchDocument"
  UNION ALL SELECT 'EntityEmbedding', "entityId", "entityType" FROM "EntityEmbedding"
)
SELECT h."table", h."kind" AS "claimed", p."kind" AS "actual", count(*)
FROM history h JOIN payload p ON p."id" = h."id" AND p."kind" <> h."kind"
WHERE NOT (h."table" = 'AuditLog' AND h."kind" = 'inventory' AND p."kind" = 'product')
GROUP BY 1, 2, 3;

-- Two data exceptions for one check on one row would collapse to one.
SELECT owner."id", x->>'check' AS "check", count(*)
FROM (
  SELECT "id", "dataExceptions" FROM "Product"
  UNION ALL SELECT "id", "dataExceptions" FROM "Purchase"
) owner
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(owner."dataExceptions", '[]'::jsonb)) x
GROUP BY owner."id", x->>'check' HAVING count(*) > 1;

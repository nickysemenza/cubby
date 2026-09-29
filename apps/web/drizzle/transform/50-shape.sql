-- Shapes: jsonb {value, unit} -> two columns, pgEnums -> text + CHECK,
-- derived-but-stored columns -> computed on read, naming, Location type, and
-- redundant index drops. Plain Postgres DDL and backfills, no BEGIN/COMMIT: the
-- caller runs every transform fragment in one transaction. Constraint and index
-- names match what Drizzle emits for apps/web/src/server/db/schema.ts.

-- ---------------------------------------------------------------------------
-- Pre-snapshot (relative checks at the end compare against it)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_shape_pre" (k text PRIMARY KEY, n bigint NOT NULL, v numeric)
  ON COMMIT DROP;
INSERT INTO "_shape_pre" (k, n) VALUES
  ('InventoryEntry', (SELECT count(*) FROM "InventoryEntry")),
  ('ProductUnitMappings', (SELECT count(*) FROM "ProductUnitMappings")),
  ('MealFoodEntry', (SELECT count(*) FROM "MealFoodEntry")),
  ('MealRecipePortion', (SELECT count(*) FROM "MealRecipePortion")),
  ('Location', (SELECT count(*) FROM "Location")),
  ('Cookbook', (SELECT count(*) FROM "Cookbook")),
  ('VendorAccount', (SELECT count(*) FROM "VendorAccount")),
  ('GardenEntry', (SELECT count(*) FROM "GardenEntry")),
  ('Recipe', (SELECT count(*) FROM "Recipe")),
  ('Image', (SELECT count(*) FROM "Image"));
-- Amount sums per unit, for every reshaped amount (unit key 'a'/'b' for the
-- two sides of a unit mapping).
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'inv:' || (amount->>'unit'), count(*), sum((amount->>'value')::numeric)
  FROM "InventoryEntry" GROUP BY amount->>'unit';
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'unitmap:a:' || (a->>'unit'), count(*), sum((a->>'value')::numeric)
  FROM "ProductUnitMappings" GROUP BY a->>'unit';
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'unitmap:b:' || (b->>'unit'), count(*), sum((b->>'value')::numeric)
  FROM "ProductUnitMappings" GROUP BY b->>'unit';
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'food:' || (amount->>'unit'), count(*), sum((amount->>'value')::numeric)
  FROM "MealFoodEntry" WHERE amount IS NOT NULL GROUP BY amount->>'unit';
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'portion:' || (amount->>'unit'), count(*), sum((amount->>'value')::numeric)
  FROM "MealRecipePortion" GROUP BY amount->>'unit';
INSERT INTO "_shape_pre" (k, n)
  SELECT 'aidesc:live_location_with_description', count(*)
  FROM "Location" WHERE "aiDescription" IS NOT NULL AND btrim("aiDescription") <> '';

-- ---------------------------------------------------------------------------
-- Guards: every assumption the transform below rests on
-- ---------------------------------------------------------------------------
DO $$
DECLARE bad bigint;
BEGIN
  -- Every stored amount is a numeric value plus a non-empty unit.
  SELECT count(*) INTO bad FROM "InventoryEntry"
    WHERE jsonb_typeof(amount) IS DISTINCT FROM 'object'
       OR jsonb_typeof(amount->'value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(amount->'unit') IS DISTINCT FROM 'string'
       OR length(btrim(amount->>'unit')) = 0
       -- no range (upperValue) or other key: the column pair cannot hold it
       OR amount - 'value' - 'unit' <> '{}'::jsonb;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % InventoryEntry amounts are not {value:number, unit:string}', bad; END IF;

  SELECT count(*) INTO bad FROM "ProductUnitMappings"
    WHERE jsonb_typeof(a->'value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(b->'value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(a->'unit') IS DISTINCT FROM 'string'
       OR jsonb_typeof(b->'unit') IS DISTINCT FROM 'string'
       OR length(btrim(a->>'unit')) = 0 OR length(btrim(b->>'unit')) = 0
       OR a - 'value' - 'unit' <> '{}'::jsonb OR b - 'value' - 'unit' <> '{}'::jsonb;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % ProductUnitMappings sides are not {value:number, unit:string}', bad; END IF;

  -- The MealFoodEntry / MealRecipePortion CHECKs already enforced this shape.
  SELECT count(*) INTO bad FROM "MealRecipePortion" WHERE amount IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % MealRecipePortion rows without an amount', bad; END IF;

  -- The Location.type NOT NULL backfill: only Product-linked rows may lack one.
  SELECT count(*) INTO bad FROM "Location" WHERE type IS NULL AND "productId" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % locations have neither a type nor a product', bad; END IF;

  -- Cookbook.sourceRecipeCount is derivable from the stored extraction.
  SELECT count(*) INTO bad FROM "Cookbook"
    WHERE "sourceRecipeCount" IS DISTINCT FROM (
      CASE WHEN jsonb_typeof("rawJson") = 'array' THEN jsonb_array_length("rawJson")
      ELSE (
        SELECT count(*) FROM jsonb_array_elements("rawJson"->'chapters') AS chapter,
          jsonb_array_elements(chapter->'items') AS item
        WHERE item->>'kind' = 'recipe'
      ) END
    );
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % cookbooks whose stored sourceRecipeCount differs from their extraction', bad; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- InventoryEntry: amount -> amountValue/amountUnit; valuation is computed on read
-- ---------------------------------------------------------------------------
ALTER TABLE "InventoryEntry"
  ADD COLUMN "amountValue" double precision,
  ADD COLUMN "amountUnit" text;
UPDATE "InventoryEntry"
  SET "amountValue" = (amount->>'value')::double precision,
      "amountUnit" = amount->>'unit';
ALTER TABLE "InventoryEntry"
  ALTER COLUMN "amountValue" SET NOT NULL,
  ALTER COLUMN "amountUnit" SET NOT NULL,
  DROP COLUMN "amount",
  DROP COLUMN "valuation";

-- ---------------------------------------------------------------------------
-- ProductUnitMappings -> ProductUnitMapping (aValue/aUnit/bValue/bUnit)
-- ---------------------------------------------------------------------------
ALTER TABLE "ProductUnitMappings" RENAME TO "ProductUnitMapping";
ALTER TABLE "ProductUnitMapping"
  RENAME CONSTRAINT "ProductUnitMappings_pkey" TO "ProductUnitMapping_pkey";
ALTER TABLE "ProductUnitMapping"
  RENAME CONSTRAINT "ProductUnitMappings_productId_Product_id_fk"
  TO "ProductUnitMapping_productId_Product_id_fk";
ALTER INDEX "ProductUnitMappings_productId_idx"
  RENAME TO "ProductUnitMapping_productId_idx";
ALTER TABLE "ProductUnitMapping"
  ADD COLUMN "aValue" double precision,
  ADD COLUMN "aUnit" text,
  ADD COLUMN "bValue" double precision,
  ADD COLUMN "bUnit" text;
UPDATE "ProductUnitMapping"
  SET "aValue" = (a->>'value')::double precision,
      "aUnit" = a->>'unit',
      "bValue" = (b->>'value')::double precision,
      "bUnit" = b->>'unit';
ALTER TABLE "ProductUnitMapping"
  ALTER COLUMN "aValue" SET NOT NULL,
  ALTER COLUMN "aUnit" SET NOT NULL,
  ALTER COLUMN "bValue" SET NOT NULL,
  ALTER COLUMN "bUnit" SET NOT NULL,
  DROP COLUMN a,
  DROP COLUMN b;

-- ---------------------------------------------------------------------------
-- MealFoodEntry / MealRecipePortion: amount -> amountValue/amountUnit + CHECK
-- (the CHECK replaces the jsonb-shape CHECK built by validMealFoodAmount)
-- ---------------------------------------------------------------------------
ALTER TABLE "MealFoodEntry" DROP CONSTRAINT "MealFoodEntry_source_check";
ALTER TABLE "MealFoodEntry" DROP CONSTRAINT "MealFoodEntry_amount_check";
ALTER TABLE "MealFoodEntry"
  ADD COLUMN "amountValue" double precision,
  ADD COLUMN "amountUnit" text;
UPDATE "MealFoodEntry"
  SET "amountValue" = (amount->>'value')::double precision,
      "amountUnit" = amount->>'unit'
  WHERE amount IS NOT NULL;
ALTER TABLE "MealFoodEntry" DROP COLUMN amount;
ALTER TABLE "MealFoodEntry" ADD CONSTRAINT "MealFoodEntry_amount_check" CHECK (
  ("MealFoodEntry"."amountValue" IS NULL AND "MealFoodEntry"."amountUnit" IS NULL) OR (
    "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."amountUnit" IS NOT NULL
    AND "MealFoodEntry"."amountValue" > 0 AND "MealFoodEntry"."amountValue" < 'Infinity'::double precision
    AND length(trim("MealFoodEntry"."amountUnit")) > 0 AND "MealFoodEntry"."amountUnit" = trim("MealFoodEntry"."amountUnit")
  )
);
ALTER TABLE "MealFoodEntry" ADD CONSTRAINT "MealFoodEntry_source_check" CHECK (("MealFoodEntry"."sourceKind" = 'ingredient' AND "MealFoodEntry"."ingredientId" IS NOT NULL AND "MealFoodEntry"."productId" IS NULL AND "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."name" IS NULL AND "MealFoodEntry"."nutrients" IS NULL) OR ("MealFoodEntry"."sourceKind" = 'product' AND "MealFoodEntry"."ingredientId" IS NULL AND "MealFoodEntry"."productId" IS NOT NULL AND "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."name" IS NULL AND "MealFoodEntry"."nutrients" IS NULL) OR ("MealFoodEntry"."sourceKind" = 'manual' AND "MealFoodEntry"."ingredientId" IS NULL AND "MealFoodEntry"."productId" IS NULL AND length(trim("MealFoodEntry"."name")) > 0 AND "MealFoodEntry"."name" IS NOT NULL AND "MealFoodEntry"."nutrients" IS NOT NULL AND jsonb_typeof("MealFoodEntry"."nutrients") = 'object' AND "MealFoodEntry"."nutrients" <> '{}'::jsonb));

ALTER TABLE "MealRecipePortion" DROP CONSTRAINT "MealRecipePortion_amount_check";
ALTER TABLE "MealRecipePortion"
  ADD COLUMN "amountValue" double precision,
  ADD COLUMN "amountUnit" text;
UPDATE "MealRecipePortion"
  SET "amountValue" = (amount->>'value')::double precision,
      "amountUnit" = amount->>'unit';
ALTER TABLE "MealRecipePortion"
  ALTER COLUMN "amountValue" SET NOT NULL,
  ALTER COLUMN "amountUnit" SET NOT NULL,
  DROP COLUMN amount;
ALTER TABLE "MealRecipePortion" ADD CONSTRAINT "MealRecipePortion_amount_check" CHECK (
  ("MealRecipePortion"."amountValue" IS NULL AND "MealRecipePortion"."amountUnit" IS NULL) OR (
    "MealRecipePortion"."amountValue" IS NOT NULL AND "MealRecipePortion"."amountUnit" IS NOT NULL
    AND "MealRecipePortion"."amountValue" > 0 AND "MealRecipePortion"."amountValue" < 'Infinity'::double precision
    AND length(trim("MealRecipePortion"."amountUnit")) > 0 AND "MealRecipePortion"."amountUnit" = trim("MealRecipePortion"."amountUnit")
  )
);

-- ---------------------------------------------------------------------------
-- pgEnums -> text + CHECK (RecipeSource is owned by the Recipe source slice).
-- Every value is kept: PENDING/FAILED and the unverified/missing/mismatch
-- states have no rows today only because they are transient workflow states.
-- ---------------------------------------------------------------------------
ALTER TABLE "Image" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Image" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
ALTER TABLE "Image" ALTER COLUMN "status" SET DEFAULT 'PENDING';
ALTER TABLE "Image" ALTER COLUMN "renderStatus" SET DATA TYPE text USING "renderStatus"::text;
ALTER TABLE "Image" ALTER COLUMN "storageStatus" SET DATA TYPE text USING "storageStatus"::text;
ALTER TABLE "InventoryEntry" ALTER COLUMN "placement" DROP DEFAULT;
ALTER TABLE "InventoryEntry" ALTER COLUMN "placement" SET DATA TYPE text USING "placement"::text;
ALTER TABLE "InventoryEntry" ALTER COLUMN "placement" SET DEFAULT 'stock';
DROP TYPE "public"."ImageStatus";
DROP TYPE "public"."ImageRenderStatus";
DROP TYPE "public"."ImageStorageStatus";
DROP TYPE "public"."InventoryPlacement";
ALTER TABLE "Image" ADD CONSTRAINT "Image_status_check"
  CHECK ("Image"."status" IN ('PENDING', 'UPLOADED', 'FAILED'));
ALTER TABLE "Image" ADD CONSTRAINT "Image_renderStatus_check"
  CHECK ("Image"."renderStatus" IN ('unverified', 'verified', 'failed'));
ALTER TABLE "Image" ADD CONSTRAINT "Image_storageStatus_check"
  CHECK ("Image"."storageStatus" IN ('unverified', 'available', 'missing', 'metadata_mismatch'));
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_placement_check"
  CHECK ("InventoryEntry"."placement" IN ('stock', 'installed'));

-- ---------------------------------------------------------------------------
-- Location.aiDescription -> AiAnalysis('location-description'); Location.type
-- ---------------------------------------------------------------------------
-- A description whose analysis row is missing keeps showing: it becomes a
-- legacy AiAnalysis dated at the location's last update, so any real analysis
-- run later is newer and wins.
INSERT INTO "AiAnalysis"
  ("entityKind", "entityId", "feature", "model", "promptVersion",
   "inputFingerprint", "result", "createdAt", "updatedAt")
SELECT 'location', l.id, 'location-description', 'legacy-column', 'legacy-column',
       'legacy:' || l.id::text,
       jsonb_build_object('description', l."aiDescription", 'confidence', 'low'),
       l."updatedAt", l."updatedAt"
FROM "Location" l
WHERE l."aiDescription" IS NOT NULL AND btrim(l."aiDescription") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "AiAnalysis" a
    WHERE a."entityKind" = 'location' AND a."entityId" = l.id
      AND a.feature = 'location-description' AND a."deletedAt" IS NULL
  );
-- A NULL column meant "no description" (every image was removed): keep that
-- state visible by retiring the analyses the column no longer points at.
UPDATE "AiAnalysis" a SET "deletedAt" = now()
FROM "Location" l
WHERE a."entityKind" = 'location' AND a."entityId" = l.id
  AND a.feature = 'location-description' AND a."deletedAt" IS NULL
  AND (l."aiDescription" IS NULL OR btrim(l."aiDescription") = '');
ALTER TABLE "Location" DROP COLUMN "aiDescription";

UPDATE "Location" SET type = 'furniture' WHERE type IS NULL;
ALTER TABLE "Location" ALTER COLUMN "type" SET NOT NULL;
ALTER TABLE "Location" ADD CONSTRAINT "Location_furniture_product_check"
  CHECK ("Location"."type" <> 'furniture' OR "Location"."productId" IS NOT NULL);
-- The "type is not recorded" check can no longer fire.
DELETE FROM "DataException" WHERE "check" = 'location_type';

-- ---------------------------------------------------------------------------
-- VendorAccount.lastRunAt/lastSuccessAt (read from Run) and
-- Cookbook.sourceRecipeCount (read from the stored extraction)
-- ---------------------------------------------------------------------------
ALTER TABLE "VendorAccount"
  DROP COLUMN "lastRunAt",
  DROP COLUMN "lastSuccessAt";
ALTER TABLE "Cookbook" DROP COLUMN "sourceRecipeCount";

-- ---------------------------------------------------------------------------
-- Naming: GardenEntry.note -> notes; Recipe.tags NOT NULL DEFAULT '{}'
-- ---------------------------------------------------------------------------
ALTER TABLE "GardenEntry" RENAME COLUMN "note" TO "notes";
UPDATE "Recipe" SET tags = '{}'::text[] WHERE tags IS NULL;
ALTER TABLE "Recipe" ALTER COLUMN "tags" SET DEFAULT '{}'::text[];
ALTER TABLE "Recipe" ALTER COLUMN "tags" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Redundant indexes: each leading column is covered by a composite
-- (Product_name_manufacturer_idx, Location_type_name_idx,
-- StatementRow_account_date_amount_idx, ImageProcessingJob_identity_key)
-- ---------------------------------------------------------------------------
DROP INDEX "Product_name_idx";
DROP INDEX "Location_type_idx";
DROP INDEX "StatementRow_accountId_idx";
DROP INDEX "ImageProcessingJob_image_idx";

-- ---------------------------------------------------------------------------
-- Relative post-checks against the pre-snapshot
-- ---------------------------------------------------------------------------
DO $$
DECLARE bad bigint; r record;
BEGIN
  FOR r IN SELECT k, n FROM "_shape_pre" WHERE k IN
    ('InventoryEntry', 'ProductUnitMappings', 'MealFoodEntry', 'MealRecipePortion',
     'Location', 'Cookbook', 'VendorAccount', 'GardenEntry', 'Recipe', 'Image')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', CASE r.k WHEN 'ProductUnitMappings' THEN 'ProductUnitMapping' ELSE r.k END)
      INTO bad;
    IF bad <> r.n THEN
      RAISE EXCEPTION 'shape: % row count changed % -> %', r.k, r.n, bad;
    END IF;
  END LOOP;

  -- Amounts preserved: per-unit row count and value sum (float8 -> numeric
  -- rounds to 15 digits, so compare with a tolerance).
  SELECT count(*) INTO bad FROM (
    SELECT 'inv:' || "amountUnit" AS k, count(*) AS n, sum("amountValue"::numeric) AS v
      FROM "InventoryEntry" GROUP BY "amountUnit"
    UNION ALL SELECT 'unitmap:a:' || "aUnit", count(*), sum("aValue"::numeric)
      FROM "ProductUnitMapping" GROUP BY "aUnit"
    UNION ALL SELECT 'unitmap:b:' || "bUnit", count(*), sum("bValue"::numeric)
      FROM "ProductUnitMapping" GROUP BY "bUnit"
    UNION ALL SELECT 'food:' || "amountUnit", count(*), sum("amountValue"::numeric)
      FROM "MealFoodEntry" WHERE "amountUnit" IS NOT NULL GROUP BY "amountUnit"
    UNION ALL SELECT 'portion:' || "amountUnit", count(*), sum("amountValue"::numeric)
      FROM "MealRecipePortion" GROUP BY "amountUnit"
  ) post
  FULL JOIN (SELECT k, n, v FROM "_shape_pre" WHERE v IS NOT NULL) pre USING (k)
  WHERE post.n IS DISTINCT FROM pre.n
     OR abs(coalesce(post.v, 0) - coalesce(pre.v, 0)) > 1e-6;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % amount groups changed by the reshape', bad; END IF;

  -- Every location that carried a description still has a live analysis.
  SELECT count(*) INTO bad FROM "Location" l
    WHERE NOT EXISTS (
      SELECT 1 FROM "AiAnalysis" a
      WHERE a."entityKind" = 'location' AND a."entityId" = l.id
        AND a.feature = 'location-description' AND a."deletedAt" IS NULL)
      AND l.id IN (SELECT DISTINCT a2."entityId" FROM "AiAnalysis" a2
        WHERE a2.model = 'legacy-column');
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % backfilled descriptions are not live', bad; END IF;
  SELECT count(*) INTO bad FROM (
    SELECT DISTINCT "entityId" FROM "AiAnalysis"
    WHERE "entityKind" = 'location' AND feature = 'location-description' AND "deletedAt" IS NULL
  ) live;
  IF bad < (SELECT n FROM "_shape_pre" WHERE k = 'aidesc:live_location_with_description') THEN
    RAISE EXCEPTION 'shape: % locations have a live description analysis, expected at least %',
      bad, (SELECT n FROM "_shape_pre" WHERE k = 'aidesc:live_location_with_description');
  END IF;

  SELECT count(*) INTO bad FROM "Location" WHERE type IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % locations still have no type', bad; END IF;
END $$;

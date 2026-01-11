-- Drop incorrect partial indexes on (id) - these provide no performance benefit
DROP INDEX IF EXISTS "Ingredient_id_deletedAt_idx";
DROP INDEX IF EXISTS "Location_id_deletedAt_idx";
DROP INDEX IF EXISTS "Product_id_deletedAt_idx";
DROP INDEX IF EXISTS "Recipe_id_deletedAt_idx";

-- Create correct partial indexes on frequently filtered columns
-- Product: name and manufacturer are the most common filters
CREATE INDEX IF NOT EXISTS "Product_name_active_idx"
  ON "Product" USING btree (name)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Product_manufacturer_active_idx"
  ON "Product" USING btree (manufacturer)
  WHERE "deletedAt" IS NULL;

-- Recipe: name is the primary filter (unique constraint already has partial index)
CREATE INDEX IF NOT EXISTS "Recipe_name_active_idx"
  ON "Recipe" USING btree (name)
  WHERE "deletedAt" IS NULL;

-- Location: name and type are common filters
CREATE INDEX IF NOT EXISTS "Location_name_active_idx"
  ON "Location" USING btree (name)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Location_type_active_idx"
  ON "Location" USING btree (type)
  WHERE "deletedAt" IS NULL;

-- Ingredient: name is the primary filter (unique constraint already has partial index)
CREATE INDEX IF NOT EXISTS "Ingredient_name_active_idx"
  ON "Ingredient" USING btree (name)
  WHERE "deletedAt" IS NULL;

-- Foreign key partial indexes for join table queries (huge performance win)
CREATE INDEX IF NOT EXISTS "ProductUnitMappings_productId_active_idx"
  ON "ProductUnitMappings" USING btree ("productId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "ProductImage_productId_active_idx"
  ON "ProductImage" USING btree ("productId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "LocationImage_locationId_active_idx"
  ON "LocationImage" USING btree ("locationId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "RecipeImage_recipeId_active_idx"
  ON "RecipeImage" USING btree ("recipeId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "RecipeSection_recipeId_active_idx"
  ON "RecipeSection" USING btree ("recipeId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "InventoryEntry_productId_active_idx"
  ON "InventoryEntry" USING btree ("productId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "InventoryEntry_locationId_active_idx"
  ON "InventoryEntry" USING btree ("locationId")
  WHERE "deletedAt" IS NULL;

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX "Ingredient_name_gin_idx" ON "public"."Ingredient" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Ingredient_aliases_gin_idx" ON "public"."Ingredient" USING GIN ("aliases");

-- CreateIndex
CREATE INDEX "Location_name_gin_idx" ON "public"."Location" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Location_type_name_idx" ON "public"."Location"("type", "name");

-- CreateIndex
CREATE INDEX "Product_name_gin_idx" ON "public"."Product" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Product_manufacturer_gin_idx" ON "public"."Product" USING GIN ("manufacturer" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Product_name_manufacturer_idx" ON "public"."Product"("name", "manufacturer");

-- CreateIndex
CREATE INDEX "ProductUnitMappings_productId_idx" ON "public"."ProductUnitMappings"("productId");

-- CreateIndex
CREATE INDEX "Recipe_name_gin_idx" ON "public"."Recipe" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Recipe_created_at_desc_idx" ON "public"."Recipe"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "usda_food_description_gin_idx" ON "public"."usda_food" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "usda_food_data_type_idx" ON "public"."usda_food"("data_type");

-- CreateIndex
CREATE INDEX "food_nutrient_nutrient_id_idx" ON "public"."usda_food_nutrient"("nutrient_id");

-- CreateIndex
CREATE INDEX "food_portion_measure_unit_id_idx" ON "public"."usda_food_portion"("measure_unit_id");

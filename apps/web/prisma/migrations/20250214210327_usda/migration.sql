-- CreateTable
CREATE TABLE "usda_branded_food" (
    "fdc_id" INTEGER NOT NULL,
    "brand_owner" TEXT,
    "brand_name" TEXT,
    "subbrand_name" TEXT,
    "gtin_upc" TEXT NOT NULL,
    "ingredients" TEXT,
    "not_a_significant_source_of" TEXT,
    "serving_size" DECIMAL(65,30),
    "serving_size_unit" TEXT,
    "household_serving_fulltext" TEXT,
    "branded_food_category" TEXT,
    "data_source" TEXT,
    "package_weight" TEXT,
    "modified_date" TEXT,
    "available_date" TEXT,
    "market_country" TEXT,
    "discontinued_date" TEXT,
    "preparation_state_code" TEXT,
    "trade_channel" TEXT,
    "short_description" TEXT,
    "material_code" TEXT,

    CONSTRAINT "usda_branded_food_pkey" PRIMARY KEY ("fdc_id")
);

-- CreateTable
CREATE TABLE "usda_food" (
    "fdc_id" INTEGER NOT NULL,
    "data_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "food_category_id" TEXT NOT NULL,
    "publication_date" TEXT NOT NULL,

    CONSTRAINT "usda_food_pkey" PRIMARY KEY ("fdc_id")
);

-- CreateTable
CREATE TABLE "usda_food_nutrient" (
    "id" INTEGER NOT NULL,
    "fdc_id" INTEGER NOT NULL,
    "nutrient_id" INTEGER NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "data_points" TEXT NOT NULL,
    "derivation_id" TEXT NOT NULL,
    "min" TEXT NOT NULL,
    "max" TEXT NOT NULL,
    "median" TEXT NOT NULL,
    "loq" TEXT NOT NULL,
    "footnote" TEXT NOT NULL,
    "min_year_acquired" TEXT NOT NULL,
    "percent_daily_value" TEXT NOT NULL,

    CONSTRAINT "usda_food_nutrient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usda_nutrient" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unit_name" TEXT NOT NULL,
    "nutrient_nbr" TEXT NOT NULL,
    "rank" TEXT NOT NULL,

    CONSTRAINT "usda_nutrient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branded_food_fdc_id" ON "usda_branded_food"("fdc_id");

-- CreateIndex
CREATE INDEX "branded_food_upc" ON "usda_branded_food"("gtin_upc");

-- CreateIndex
CREATE INDEX "food_fdc_id" ON "usda_food"("fdc_id");

-- CreateIndex
CREATE INDEX "food_nutrient_fdc_id" ON "usda_food_nutrient"("fdc_id");

-- AddForeignKey
ALTER TABLE "usda_branded_food" ADD CONSTRAINT "usda_branded_food_fdc_id_fkey" FOREIGN KEY ("fdc_id") REFERENCES "usda_food"("fdc_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "usda_food_nutrient" ADD CONSTRAINT "usda_food_nutrient_nutrient_id_fkey" FOREIGN KEY ("nutrient_id") REFERENCES "usda_nutrient"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "usda_food_nutrient" ADD CONSTRAINT "usda_food_nutrient_fdc_id_fkey" FOREIGN KEY ("fdc_id") REFERENCES "usda_food"("fdc_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

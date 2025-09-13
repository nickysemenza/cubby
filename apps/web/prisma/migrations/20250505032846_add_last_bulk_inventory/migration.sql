/*
  Warnings:

  - A unique constraint covering the columns `[productId,locationId]` on the table `InventoryEntry` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[ndb_number]` on the table `Product` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "lastBulkInventory" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "ndb_number" INTEGER;

-- CreateTable
CREATE TABLE "usda_measure_unit" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "usda_measure_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usda_food_portion" (
    "id" INTEGER NOT NULL,
    "fdc_id" INTEGER NOT NULL,
    "seq_num" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "measure_unit_id" INTEGER NOT NULL,
    "portion_description" TEXT,
    "modifier" TEXT,
    "gram_weight" DECIMAL(65,30) NOT NULL,
    "data_points" TEXT,
    "footnote" TEXT,
    "min_year_acquired" TEXT,

    CONSTRAINT "usda_food_portion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usda_sr_legacy_food" (
    "fdc_id" INTEGER NOT NULL,
    "NDB_number" INTEGER NOT NULL,

    CONSTRAINT "usda_sr_legacy_food_pkey" PRIMARY KEY ("fdc_id")
);

-- CreateIndex
CREATE INDEX "food_portion_fdc_id" ON "usda_food_portion"("fdc_id");

-- CreateIndex
CREATE UNIQUE INDEX "usda_sr_legacy_food_NDB_number_key" ON "usda_sr_legacy_food"("NDB_number");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryEntry_productId_locationId_key" ON "InventoryEntry"("productId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_ndb_number_key" ON "Product"("ndb_number");

-- AddForeignKey
ALTER TABLE "usda_food_portion" ADD CONSTRAINT "usda_food_portion_fdc_id_fkey" FOREIGN KEY ("fdc_id") REFERENCES "usda_food"("fdc_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "usda_food_portion" ADD CONSTRAINT "usda_food_portion_measure_unit_id_fkey" FOREIGN KEY ("measure_unit_id") REFERENCES "usda_measure_unit"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

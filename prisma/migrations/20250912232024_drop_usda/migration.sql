/*
  Warnings:

  - You are about to drop the `usda_branded_food` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `usda_food` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `usda_food_nutrient` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `usda_food_portion` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `usda_measure_unit` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `usda_nutrient` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `usda_sr_legacy_food` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."usda_branded_food" DROP CONSTRAINT "usda_branded_food_fdc_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."usda_food_nutrient" DROP CONSTRAINT "usda_food_nutrient_fdc_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."usda_food_nutrient" DROP CONSTRAINT "usda_food_nutrient_nutrient_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."usda_food_portion" DROP CONSTRAINT "usda_food_portion_fdc_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."usda_food_portion" DROP CONSTRAINT "usda_food_portion_measure_unit_id_fkey";

-- DropTable
DROP TABLE "public"."usda_branded_food";

-- DropTable
DROP TABLE "public"."usda_food";

-- DropTable
DROP TABLE "public"."usda_food_nutrient";

-- DropTable
DROP TABLE "public"."usda_food_portion";

-- DropTable
DROP TABLE "public"."usda_measure_unit";

-- DropTable
DROP TABLE "public"."usda_nutrient";

-- DropTable
DROP TABLE "public"."usda_sr_legacy_food";

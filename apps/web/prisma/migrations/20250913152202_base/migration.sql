-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "public"."RecipeSource" AS ENUM ('Book', 'Website', 'Other');

-- CreateEnum
CREATE TYPE "public"."ImageStatus" AS ENUM ('PENDING', 'UPLOADED', 'FAILED');

-- CreateTable
CREATE TABLE "public"."Recipe" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "SourceType" "public"."RecipeSource",
    "SourceData" TEXT,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecipeSection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipeId" UUID NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "instructions" JSONB[],

    CONSTRAINT "RecipeSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecipeSectionIngredient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipeSectionId" UUID NOT NULL,
    "ingredientId" UUID NOT NULL,
    "amounts" JSONB[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecipeSectionIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Ingredient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "aliases" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "recipeId" UUID,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Product" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "upc" TEXT,
    "ndb_number" INTEGER,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "ingredientId" UUID,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProductUnitMappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "a" JSONB NOT NULL,
    "b" JSONB NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductUnitMappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "amount" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "locationId" UUID NOT NULL,

    CONSTRAINT "InventoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Location" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "lastBulkInventory" TIMESTAMP(3),
    "parentId" UUID,
    "type" TEXT NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Image" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "url" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "status" "public"."ImageStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProductImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "imageId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LocationImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "locationId" UUID NOT NULL,
    "imageId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LocationImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecipeImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipeId" UUID NOT NULL,
    "imageId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecipeImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_name_key" ON "public"."Recipe"("name");

-- CreateIndex
CREATE INDEX "Recipe_createdAt_idx" ON "public"."Recipe"("createdAt");

-- CreateIndex
CREATE INDEX "Recipe_SourceType_idx" ON "public"."Recipe"("SourceType");

-- CreateIndex
CREATE INDEX "Recipe_name_gin_idx" ON "public"."Recipe" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Recipe_created_at_desc_idx" ON "public"."Recipe"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "RecipeSection_recipeId_idx" ON "public"."RecipeSection"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeSection_createdAt_idx" ON "public"."RecipeSection"("createdAt");

-- CreateIndex
CREATE INDEX "RecipeSectionIngredient_recipeSectionId_idx" ON "public"."RecipeSectionIngredient"("recipeSectionId");

-- CreateIndex
CREATE INDEX "RecipeSectionIngredient_ingredientId_idx" ON "public"."RecipeSectionIngredient"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_name_key" ON "public"."Ingredient"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_recipeId_key" ON "public"."Ingredient"("recipeId");

-- CreateIndex
CREATE INDEX "Ingredient_recipeId_idx" ON "public"."Ingredient"("recipeId");

-- CreateIndex
CREATE INDEX "Ingredient_createdAt_idx" ON "public"."Ingredient"("createdAt");

-- CreateIndex
CREATE INDEX "Ingredient_name_gin_idx" ON "public"."Ingredient" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Ingredient_aliases_gin_idx" ON "public"."Ingredient" USING GIN ("aliases");

-- CreateIndex
CREATE UNIQUE INDEX "Product_upc_key" ON "public"."Product"("upc");

-- CreateIndex
CREATE UNIQUE INDEX "Product_ndb_number_key" ON "public"."Product"("ndb_number");

-- CreateIndex
CREATE INDEX "Product_ingredientId_idx" ON "public"."Product"("ingredientId");

-- CreateIndex
CREATE INDEX "Product_createdAt_idx" ON "public"."Product"("createdAt");

-- CreateIndex
CREATE INDEX "Product_name_idx" ON "public"."Product"("name");

-- CreateIndex
CREATE INDEX "Product_name_gin_idx" ON "public"."Product" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Product_manufacturer_gin_idx" ON "public"."Product" USING GIN ("manufacturer" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Product_name_manufacturer_idx" ON "public"."Product"("name", "manufacturer");

-- CreateIndex
CREATE UNIQUE INDEX "Product_name_manufacturer_key" ON "public"."Product"("name", "manufacturer");

-- CreateIndex
CREATE INDEX "ProductUnitMappings_productId_idx" ON "public"."ProductUnitMappings"("productId");

-- CreateIndex
CREATE INDEX "InventoryEntry_productId_idx" ON "public"."InventoryEntry"("productId");

-- CreateIndex
CREATE INDEX "InventoryEntry_locationId_idx" ON "public"."InventoryEntry"("locationId");

-- CreateIndex
CREATE INDEX "InventoryEntry_createdAt_idx" ON "public"."InventoryEntry"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryEntry_productId_locationId_key" ON "public"."InventoryEntry"("productId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_name_key" ON "public"."Location"("name");

-- CreateIndex
CREATE INDEX "Location_name_idx" ON "public"."Location"("name");

-- CreateIndex
CREATE INDEX "Location_type_idx" ON "public"."Location"("type");

-- CreateIndex
CREATE INDEX "Location_parentId_idx" ON "public"."Location"("parentId");

-- CreateIndex
CREATE INDEX "Location_createdAt_idx" ON "public"."Location"("createdAt");

-- CreateIndex
CREATE INDEX "Location_lastBulkInventory_idx" ON "public"."Location"("lastBulkInventory");

-- CreateIndex
CREATE INDEX "Location_name_gin_idx" ON "public"."Location" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Location_type_name_idx" ON "public"."Location"("type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Image_key_key" ON "public"."Image"("key");

-- CreateIndex
CREATE INDEX "Image_createdAt_idx" ON "public"."Image"("createdAt");

-- CreateIndex
CREATE INDEX "Image_status_idx" ON "public"."Image"("status");

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "public"."ProductImage"("productId");

-- CreateIndex
CREATE INDEX "ProductImage_imageId_idx" ON "public"."ProductImage"("imageId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_productId_imageId_key" ON "public"."ProductImage"("productId", "imageId");

-- CreateIndex
CREATE INDEX "LocationImage_locationId_idx" ON "public"."LocationImage"("locationId");

-- CreateIndex
CREATE INDEX "LocationImage_imageId_idx" ON "public"."LocationImage"("imageId");

-- CreateIndex
CREATE UNIQUE INDEX "LocationImage_locationId_imageId_key" ON "public"."LocationImage"("locationId", "imageId");

-- CreateIndex
CREATE INDEX "RecipeImage_recipeId_idx" ON "public"."RecipeImage"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeImage_imageId_idx" ON "public"."RecipeImage"("imageId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeImage_recipeId_imageId_key" ON "public"."RecipeImage"("recipeId", "imageId");

-- AddForeignKey
ALTER TABLE "public"."RecipeSection" ADD CONSTRAINT "RecipeSection_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeSectionIngredient" ADD CONSTRAINT "RecipeSectionIngredient_recipeSectionId_fkey" FOREIGN KEY ("recipeSectionId") REFERENCES "public"."RecipeSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeSectionIngredient" ADD CONSTRAINT "RecipeSectionIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ingredient" ADD CONSTRAINT "Ingredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Product" ADD CONSTRAINT "Product_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductUnitMappings" ADD CONSTRAINT "ProductUnitMappings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryEntry" ADD CONSTRAINT "InventoryEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryEntry" ADD CONSTRAINT "InventoryEntry_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Location" ADD CONSTRAINT "Location_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductImage" ADD CONSTRAINT "ProductImage_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LocationImage" ADD CONSTRAINT "LocationImage_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LocationImage" ADD CONSTRAINT "LocationImage_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeImage" ADD CONSTRAINT "RecipeImage_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeImage" ADD CONSTRAINT "RecipeImage_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

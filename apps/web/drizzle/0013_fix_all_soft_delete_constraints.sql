ALTER TABLE "Image" DROP CONSTRAINT "Image_key_unique";--> statement-breakpoint
ALTER TABLE "Location" DROP CONSTRAINT "Location_shortcode_unique";--> statement-breakpoint
ALTER TABLE "Product" DROP CONSTRAINT "Product_shortcode_unique";--> statement-breakpoint
ALTER TABLE "Recipe" DROP CONSTRAINT "Recipe_shortcode_unique";--> statement-breakpoint
DROP INDEX "Ingredient_recipeId_key";--> statement-breakpoint
DROP INDEX "InventoryEntry_productId_locationId_key";--> statement-breakpoint
DROP INDEX "LocationImage_locationId_imageId_key";--> statement-breakpoint
DROP INDEX "Product_upc_key";--> statement-breakpoint
DROP INDEX "Product_ndb_number_key";--> statement-breakpoint
DROP INDEX "ProductImage_productId_imageId_key";--> statement-breakpoint
DROP INDEX "RecipeImage_recipeId_imageId_key";--> statement-breakpoint
CREATE UNIQUE INDEX "Image_key_key" ON "Image" USING btree ("key") WHERE "Image"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Location_shortcode_unique" ON "Location" USING btree ("shortcode") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Product_shortcode_unique" ON "Product" USING btree ("shortcode") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_shortcode_unique" ON "Recipe" USING btree ("shortcode") WHERE "Recipe"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_recipeId_key" ON "Ingredient" USING btree ("recipeId") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "InventoryEntry_productId_locationId_key" ON "InventoryEntry" USING btree ("productId","locationId") WHERE "InventoryEntry"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "LocationImage_locationId_imageId_key" ON "LocationImage" USING btree ("locationId","imageId") WHERE "LocationImage"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Product_upc_key" ON "Product" USING btree ("upc") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Product_ndb_number_key" ON "Product" USING btree ("ndb_number") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ProductImage_productId_imageId_key" ON "ProductImage" USING btree ("productId","imageId") WHERE "ProductImage"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "RecipeImage_recipeId_imageId_key" ON "RecipeImage" USING btree ("recipeId","imageId") WHERE "RecipeImage"."deletedAt" IS NULL;
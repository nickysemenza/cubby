CREATE INDEX "Ingredient_id_deletedAt_idx" ON "Ingredient" USING btree ("id") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Location_id_deletedAt_idx" ON "Location" USING btree ("id") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_id_deletedAt_idx" ON "Product" USING btree ("id") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Recipe_id_deletedAt_idx" ON "Recipe" USING btree ("id") WHERE "Recipe"."deletedAt" IS NULL;
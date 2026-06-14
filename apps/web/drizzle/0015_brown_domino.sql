DROP INDEX "Ingredient_name_key";--> statement-breakpoint
DROP INDEX "Location_name_key";--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient" USING btree (lower("name")) WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Location_name_key" ON "Location" USING btree (lower("name")) WHERE "Location"."deletedAt" IS NULL;
DROP INDEX "Recipe_name_key";--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_book_title_key" ON "Recipe" USING btree ("name","SourceData") WHERE "Recipe"."deletedAt" IS NULL AND "Recipe"."SourceType" = 'Book';--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_name_key" ON "Recipe" USING btree ("name") WHERE "Recipe"."deletedAt" IS NULL AND "Recipe"."SourceType" IS DISTINCT FROM 'Book';
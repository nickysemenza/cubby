-- Add yield, servings, and tags columns to Recipe table
ALTER TABLE "Recipe" ADD COLUMN "yield" JSONB;
ALTER TABLE "Recipe" ADD COLUMN "servings" INTEGER;
ALTER TABLE "Recipe" ADD COLUMN "tags" TEXT[];

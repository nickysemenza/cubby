-- Add shortcode column for recipes (R-XXXX format)
ALTER TABLE "Recipe" ADD COLUMN "shortcode" text UNIQUE;

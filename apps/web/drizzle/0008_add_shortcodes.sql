-- Add shortcode columns for human-readable IDs (L-XXXX, P-XXXX format)
ALTER TABLE "Product" ADD COLUMN "shortcode" text UNIQUE NOT NULL;
ALTER TABLE "Location" ADD COLUMN "shortcode" text UNIQUE NOT NULL;

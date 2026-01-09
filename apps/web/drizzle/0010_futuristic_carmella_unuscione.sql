CREATE TABLE "AppSettings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "invitation" CASCADE;--> statement-breakpoint
DROP TABLE "organization" CASCADE;--> statement-breakpoint
DROP TABLE "member" CASCADE;--> statement-breakpoint
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_organizationId_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "Image" DROP CONSTRAINT "Image_organizationId_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "Ingredient" DROP CONSTRAINT "Ingredient_organizationId_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "InventoryEntry" DROP CONSTRAINT "InventoryEntry_organizationId_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "Location" DROP CONSTRAINT "Location_organizationId_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "Product" DROP CONSTRAINT "Product_organizationId_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "Recipe" DROP CONSTRAINT "Recipe_organizationId_organization_id_fk";
--> statement-breakpoint
DROP INDEX "AuditLog_organizationId_createdAt_idx";--> statement-breakpoint
DROP INDEX "Image_organizationId_idx";--> statement-breakpoint
DROP INDEX "Ingredient_organizationId_name_key";--> statement-breakpoint
DROP INDEX "Ingredient_organizationId_idx";--> statement-breakpoint
DROP INDEX "InventoryEntry_organizationId_idx";--> statement-breakpoint
DROP INDEX "Location_organizationId_name_key";--> statement-breakpoint
DROP INDEX "Location_organizationId_idx";--> statement-breakpoint
DROP INDEX "Product_organizationId_name_manufacturer_key";--> statement-breakpoint
DROP INDEX "Product_organizationId_idx";--> statement-breakpoint
DROP INDEX "Recipe_organizationId_name_key";--> statement-breakpoint
DROP INDEX "Recipe_organizationId_idx";--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD COLUMN "valuation" real;--> statement-breakpoint
ALTER TABLE "Location" ADD COLUMN "shortcode" text NOT NULL;--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN "shortcode" text NOT NULL;--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN "price" real;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "shortcode" text;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "yield" jsonb;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "servings" integer;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "tags" text[];--> statement-breakpoint
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog" USING btree ("createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient" USING btree ("name") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Location_name_key" ON "Location" USING btree ("name") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Product_name_manufacturer_key" ON "Product" USING btree ("name","manufacturer") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_name_key" ON "Recipe" USING btree ("name") WHERE "Recipe"."deletedAt" IS NULL;--> statement-breakpoint
ALTER TABLE "AuditLog" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "Image" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "Ingredient" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "InventoryEntry" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "Location" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "Product" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "Recipe" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "active_organization_id";--> statement-breakpoint
ALTER TABLE "Location" ADD CONSTRAINT "Location_shortcode_unique" UNIQUE("shortcode");--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_shortcode_unique" UNIQUE("shortcode");--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_shortcode_unique" UNIQUE("shortcode");
-- Drop organizationId column from all tables that have it
-- This aligns the database with the current Drizzle schema which doesn't define this column

-- Drop foreign key constraints first
ALTER TABLE "Image" DROP CONSTRAINT IF EXISTS "Image_organizationId_organization_id_fk";
ALTER TABLE "Ingredient" DROP CONSTRAINT IF EXISTS "Ingredient_organizationId_organization_id_fk";
ALTER TABLE "InventoryEntry" DROP CONSTRAINT IF EXISTS "InventoryEntry_organizationId_organization_id_fk";
ALTER TABLE "Location" DROP CONSTRAINT IF EXISTS "Location_organizationId_organization_id_fk";
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_organizationId_organization_id_fk";
ALTER TABLE "Recipe" DROP CONSTRAINT IF EXISTS "Recipe_organizationId_organization_id_fk";
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_organizationId_organization_id_fk";

-- Drop indexes
DROP INDEX IF EXISTS "Image_organizationId_idx";
DROP INDEX IF EXISTS "Ingredient_organizationId_name_key";
DROP INDEX IF EXISTS "Ingredient_organizationId_idx";
DROP INDEX IF EXISTS "InventoryEntry_organizationId_idx";
DROP INDEX IF EXISTS "Location_organizationId_name_key";
DROP INDEX IF EXISTS "Location_organizationId_idx";
DROP INDEX IF EXISTS "Product_organizationId_name_manufacturer_key";
DROP INDEX IF EXISTS "Product_organizationId_idx";
DROP INDEX IF EXISTS "Recipe_organizationId_name_key";
DROP INDEX IF EXISTS "Recipe_organizationId_idx";
DROP INDEX IF EXISTS "AuditLog_organizationId_idx";

-- Drop the columns
ALTER TABLE "Image" DROP COLUMN IF EXISTS "organizationId";
ALTER TABLE "Ingredient" DROP COLUMN IF EXISTS "organizationId";
ALTER TABLE "InventoryEntry" DROP COLUMN IF EXISTS "organizationId";
ALTER TABLE "Location" DROP COLUMN IF EXISTS "organizationId";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "organizationId";
ALTER TABLE "Recipe" DROP COLUMN IF EXISTS "organizationId";
ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS "organizationId";

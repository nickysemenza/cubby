import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  unsafeOrganizationId,
  unsafeUserId,
  type OrganizationId,
} from "../src/schemas/identifiers";
import { type Database } from "../src/server/db/database";
import { type ActorContext } from "../src/schemas/context";
import * as schema from "../src/server/db/schema";

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

let hash = "";

// Standard test IDs used across all tests
export const TEST_ORG_ID = "test-org-id";
export const TEST_USER_ID = "test-user-id";

export async function setup() {
  console.log("TEST GLOBAL SETUP");
  hash = await integreSQL.hashFiles(["./src/server/db/schema.ts"]);

  // Initialize the template database
  await integreSQL.initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
      remapDBConfig(databaseConfig),
    );

    console.log("Migrating template database");
    const pool = new Pool({ connectionString: connectionUrl });
    const db = drizzle(pool);

    await migrate(db, { migrationsFolder: "./drizzle" });

    console.log("Template database migrated");
    await pool.end();
  });
}
export async function buildTestDB() {
  const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });
  const hash = await integreSQL.hashFiles(["./src/server/db/schema.ts"]);
  const databaseConfig = await integreSQL.getTestDatabase(hash);
  console.log("testdb:", databaseConfig.database);
  const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
    remapDBConfig(databaseConfig),
  );

  // Create drizzle client directly without importing from db.ts
  const pool = new Pool({ connectionString: connectionUrl });
  const rawDb = drizzle({ client: pool, schema });

  // Automatically create a test user
  await rawDb
    .insert(schema.user)
    .values({
      id: TEST_USER_ID,
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0]!);

  // Automatically create a test organization
  const testOrg = await rawDb
    .insert(schema.organization)
    .values({
      id: TEST_ORG_ID,
      name: "Test Organization",
      slug: "test-organization",
      createdAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0]!);

  // Create member relationship between user and org
  await rawDb.insert(schema.organizationMember).values({
    id: "test-member-id",
    userId: TEST_USER_ID,
    organizationId: TEST_ORG_ID,
    role: "owner",
    createdAt: new Date(),
  });

  const teardown = async () => {
    await pool.end();
  };

  const actor: ActorContext = {
    userId: unsafeUserId(TEST_USER_ID),
    organizationId: unsafeOrganizationId(testOrg.id),
    source: "ui",
  };

  return {
    db: rawDb as unknown as Database,
    organizationId: unsafeOrganizationId(testOrg.id),
    actor,
    teardown,
  };
}

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  databaseConfig.host = "localhost";
  // Always use port 5555 (mapped from container's 5432)
  databaseConfig.port = 5555;
  return databaseConfig;
};

// ============================================================================
// CSV Seed Helper
// ============================================================================

import {
  importInventoryFromCSV,
  inventoryentryList,
} from "../src/server/repo/inventory";
import {
  type InventoryCSVRow,
  type CSVImportResult,
} from "../src/schemas/inventory";
import {
  type ProductId,
  type LocationId,
  type InventoryId,
  productId as productIdSchema,
  locationId as locationIdSchema,
  inventoryId as inventoryIdSchema,
} from "../src/schemas/identifiers";

export interface SeedResult {
  /** Import result with counts and per-row details */
  result: CSVImportResult;
  /** Lookup product ID by name */
  productIds: Map<string, ProductId>;
  /** Lookup location ID by name (leaf name, not full path) */
  locationIds: Map<string, LocationId>;
  /** Lookup inventory entry ID by "productName@locationPath" */
  inventoryIds: Map<string, InventoryId>;
}

/**
 * Seed test data using CSV import
 *
 * This is a convenience wrapper around importInventoryFromCSV that:
 * 1. Runs the import (not dry-run)
 * 2. Returns lookup maps for created entity IDs
 *
 * @example
 * ```ts
 * const seed = await seedFromCSV(db, organizationId, [
 *   { product_name: "Flour", manufacturer: "Brand", location_path: "Pantry[room]", quantity: 5, unit: "lbs" },
 *   { product_name: "Blender", manufacturer: "KitchenAid" }, // product-only (no inventory)
 * ], actor);
 *
 * // Get IDs for assertions or further operations
 * const flourId = seed.productIds.get("Flour")!;
 * const pantryId = seed.locationIds.get("Pantry")!;
 * ```
 */
export async function seedFromCSV(
  db: Database,
  organizationId: OrganizationId,
  rows: Array<Partial<InventoryCSVRow> & { product_name: string }>,
  actor: ActorContext,
): Promise<SeedResult> {
  // Apply defaults for convenience
  const normalizedRows: InventoryCSVRow[] = rows.map((row) => ({
    product_name: row.product_name,
    manufacturer: row.manufacturer ?? "(unspecified)",
    upc: row.upc,
    model: row.model,
    ndb_number: row.ndb_number,
    location_path: row.location_path ?? "",
    quantity: row.quantity ?? 1,
    unit: row.unit ?? "each",
    expected_qty: row.expected_qty,
    price: row.price,
    unit_mappings: row.unit_mappings,
    ingredient_name: row.ingredient_name,
    ingredient: row.ingredient,
    aliases: row.aliases,
  }));

  const result = await importInventoryFromCSV(
    db,
    organizationId,
    normalizedRows,
    {
      dryRun: false,
      actor,
    },
  );

  // Check for errors
  if (result.errors > 0) {
    const errorMessages = result.items
      .filter((item) => item.action === "error")
      .map((item) => `Row ${item.rowIndex}: ${item.message}`)
      .join("\n");
    throw new Error(`seedFromCSV failed with errors:\n${errorMessages}`);
  }

  // Build lookup maps
  const productIds = new Map<string, ProductId>();
  const locationIds = new Map<string, LocationId>();
  const inventoryIds = new Map<string, InventoryId>();

  for (const item of result.items) {
    // Product ID by name
    if (item.productId && item.productName) {
      productIds.set(item.productName, productIdSchema.parse(item.productId));
    }

    // Location ID by leaf name (last segment of path)
    if (item.locationId && item.locationPath) {
      const leafName =
        item.locationPath.split(">").pop()?.trim() ?? item.locationPath;
      // Remove type annotation if present: "Pantry[room]" -> "Pantry"
      const cleanName = leafName.replace(/\[.*?\]$/, "").trim();
      locationIds.set(cleanName, locationIdSchema.parse(item.locationId));
    }
  }

  // Query for inventory entries to get their IDs
  // (import doesn't return inventoryEntryId for created entries)
  const inventoryEntries = await inventoryentryList(
    db,
    organizationId,
    { orderBy: "createdAt", direction: "asc" },
    { pageIndex: 0, pageSize: 1000 },
  );

  for (const entry of inventoryEntries.data) {
    const productName = entry.product.name;
    const locationName = entry.location.name;
    const key = `${productName}@${locationName}`;
    inventoryIds.set(key, inventoryIdSchema.parse(entry.id));
  }

  return { result, productIds, locationIds, inventoryIds };
}

// Re-export types for convenience
export type { InventoryCSVRow } from "../src/schemas/inventory";
export type { OrganizationId } from "../src/schemas/identifiers";

import type { ActorContext } from "@cubby/schemas/context";
import {
  type InventoryId,
  inventoryId as inventoryIdSchema,
  type LocationId,
  locationId as locationIdSchema,
  type ProductId,
  productId as productIdSchema,
  unsafeUserId,
} from "@cubby/schemas/identifiers";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { Database } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

let hash = "";

// Standard test IDs used across all tests
export const TEST_USER_ID = "test-user-id";

/**
 * Generate a hash for IntegreSSQL template identification
 * Includes both schema and migrations journal to detect any DB changes
 */
async function getTemplateHash(): Promise<string> {
  return integreSQL.hashFiles([
    "./src/server/db/schema.ts",
    "./drizzle/meta/_journal.json",
  ]);
}

export async function setup() {
  console.log("TEST GLOBAL SETUP");
  hash = await getTemplateHash();

  // Initialize the template database
  await integreSQL.initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
      remapDBConfig(databaseConfig),
    );

    console.log("Migrating template database");
    const pool = new Pool({ connectionString: connectionUrl });
    const db = drizzle(pool);

    try {
      await migrate(db, { migrationsFolder: "./drizzle" });
      console.log("Template database migrated");
    } catch (err) {
      console.error("Migration failed:", err);
      throw err;
    } finally {
      await pool.end();
    }
  });
}
export async function buildTestDB() {
  const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });
  const hash = await getTemplateHash();
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

  const teardown = async () => {
    await pool.end();
  };

  const actor: ActorContext = {
    userId: unsafeUserId(TEST_USER_ID),
    source: "ui",
  };

  return {
    db: rawDb as unknown as Database,
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

import type {
  CSVImportResult,
  InventoryCSVRow,
} from "@cubby/schemas/inventory";
// NOTE: We use dynamic imports for repo modules to avoid loading env.js
// during vitest globalSetup phase (before test.env variables are applied)

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
 * const seed = await seedFromCSV(db, [
 *   { product_name: "Flour", manufacturer: "Brand", location_name: "Pantry", quantity: 5, unit: "lbs" },
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
  rows: Array<Partial<InventoryCSVRow> & { product_name: string }>,
  actor: ActorContext,
): Promise<SeedResult> {
  // Dynamic import to avoid loading env.js during globalSetup
  const { importInventoryFromCSV, inventoryentryList } = await import(
    "../src/server/repo/inventory"
  );
  const { findOrCreateLocationByName } = await import(
    "../src/server/repo/location"
  );

  // Auto-create any locations referenced in the rows
  const uniqueLocationNames = [
    ...new Set(
      rows.map((r) => r.location_name).filter((name): name is string => !!name),
    ),
  ];
  for (const locationName of uniqueLocationNames) {
    await findOrCreateLocationByName(
      db,
      locationName,
      null, // parentId - test locations are roots
      "room", // type - default to room for test locations
    );
  }

  // Apply defaults for convenience
  const normalizedRows: InventoryCSVRow[] = rows.map((row) => ({
    product_name: row.product_name,
    manufacturer: row.manufacturer ?? "(unspecified)",
    upc: row.upc,
    model: row.model,
    ndb_number: row.ndb_number,
    location_name: row.location_name ?? "",
    quantity: row.quantity ?? 1,
    unit: row.unit ?? "each",
    expected_qty: row.expected_qty,
    price: row.price,
    unit_mappings: row.unit_mappings,
    ingredient_name: row.ingredient_name,
    ingredient: row.ingredient,
    aliases: row.aliases,
  }));

  const result = await importInventoryFromCSV(db, normalizedRows, {
    dryRun: false,
    actor,
  });

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

    // Location ID by name
    if (item.locationId && item.locationName) {
      locationIds.set(
        item.locationName,
        locationIdSchema.parse(item.locationId),
      );
    }
  }

  // Query for inventory entries to get their IDs
  // (import doesn't return inventoryEntryId for created entries)
  const inventoryEntries = await inventoryentryList(
    db,
    {},
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
export type { InventoryCSVRow } from "@cubby/schemas/inventory";

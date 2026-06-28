import type { ActorContext } from "@cubby/schemas/context";
import {
  type InventoryId,
  inventoryId as inventoryIdSchema,
  type LocationId,
  type ProductId,
  productId as productIdSchema,
  unsafeUserId,
} from "@cubby/schemas/identifiers";
import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { pushSchema } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { beforeEach } from "vitest";
import type { Database } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { ensureDbExtensions } from "./db-extensions";

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

let hash = "";

// Standard test IDs used across all tests
export const TEST_USER_ID = "test-user-id";

/**
 * The authenticated actor every integration test runs as. Mirrors what
 * `buildTestDB()` returns — import this instead of redefining a local
 * `TEST_ACTOR` (or `unsafeUserId("test-user-id")`) per file.
 */
export const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId(TEST_USER_ID),
  source: "ui",
};

/**
 * A syntactically-valid UUID guaranteed absent from a fresh test DB — for
 * "operate on a non-existent entity" assertions.
 */
export const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Generate a hash for IntegreSQL template identification.
 * Schema.ts is the single source of truth — the template is pushed from it
 * directly (see setup), so hashing the schema alone detects any DB change.
 */
async function getTemplateHash(): Promise<string> {
  return integreSQL.hashFiles(["./src/server/db/schema.ts"]);
}

export async function setup() {
  console.log("TEST GLOBAL SETUP");
  hash = await getTemplateHash();

  // Initialize the template database
  await integreSQL.initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
      remapDBConfig(databaseConfig),
    );

    console.log("Pushing schema to template database");
    const pool = new Pool({ connectionString: connectionUrl });
    const db = drizzle(pool);

    try {
      // pushSchema doesn't manage extensions; create them before pushing
      // (mirrors db:push and E2E setup).
      await ensureDbExtensions(db);
      // `db` and drizzle-kit are typed against different physical copies of
      // drizzle-orm (an @opentelemetry/api peer-dep dupe), so bridge the
      // structurally-identical PgDatabase types. Runtime parity is covered by
      // the integration + E2E suites.
      const { apply } = await pushSchema(
        schema,
        db as unknown as Parameters<typeof pushSchema>[1],
        ["public"],
      );
      await apply();
      console.log("Template database schema pushed");
    } catch (err) {
      console.error("Schema push failed:", err);
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

  return {
    db: rawDb as unknown as Database,
    actor: TEST_ACTOR,
    teardown,
  };
}

/** Holder returned by {@link withTestDb}; fields are live before each test. */
export interface TestDbContext {
  db: Database;
  actor: ActorContext;
}

/**
 * Per-test database scaffold. Call once at the top of a `describe`: it registers
 * a `beforeEach` that provisions a fresh IntegreSQL database (with seeded test
 * user) and tears it down afterward, and returns a holder whose `.db`/`.actor`
 * are populated before each test body runs.
 *
 * ```ts
 * const ctx = withTestDb();
 * it("creates a product", async () => {
 *   await createProduct(ctx.db, makeProductInput(), ctx.actor);
 * });
 * ```
 *
 * Replaces the hand-rolled `let db; let teardown; beforeEach(() => ({ db,
 * teardown } = await buildTestDB()))` block. Files that need a non-"ui" actor
 * (e.g. `epub_import`) should keep calling {@link buildTestDB} directly.
 */
export function withTestDb(): TestDbContext {
  // `db` is assigned in the beforeEach below before any test reads it; the cast
  // keeps call sites free of an `undefined` union they'd otherwise have to narrow.
  const ctx: TestDbContext = {
    db: undefined as unknown as Database,
    actor: TEST_ACTOR,
  };
  beforeEach(async () => {
    const { db, actor, teardown } = await buildTestDB();
    ctx.db = db;
    ctx.actor = actor;
    return teardown;
  });
  return ctx;
}

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  databaseConfig.host = "localhost";
  databaseConfig.port = 5432;
  return databaseConfig;
};

// NOTE: We use dynamic imports for repo modules to avoid loading env.js
// during vitest globalSetup phase (before test.env variables are applied)

export interface SeedResult {
  /** Lookup product ID by name */
  productIds: Map<string, ProductId>;
  /** Lookup location ID by name (leaf name, not full path) */
  locationIds: Map<string, LocationId>;
  /** Lookup inventory entry ID by "productName@locationName" */
  inventoryIds: Map<string, InventoryId>;
}

/** Minimal row shape for seeding inventory test data. */
export interface SeedRow {
  product_name: string;
  manufacturer?: string;
  location_name?: string;
  quantity?: number;
  unit?: string;
  price?: number;
  expected_qty?: number | null;
  upc?: string;
}

/**
 * Seed inventory test data via direct repo calls.
 *
 * Creates products (deduped by name), auto-creates any referenced locations,
 * and places inventory. Returns lookup maps of the created entity IDs.
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
  rows: SeedRow[],
  actor: ActorContext,
): Promise<SeedResult> {
  // Dynamic import to avoid loading env.js during globalSetup
  const { createInventoryEntry, inventoryentryList } = await import(
    "../src/server/repo/inventory"
  );
  const { quickCreateProduct } = await import("../src/server/repo/product");
  const { findOrCreateLocationByName } = await import(
    "../src/server/repo/location"
  );

  const productIds = new Map<string, ProductId>();
  const locationIds = new Map<string, LocationId>();
  const inventoryIds = new Map<string, InventoryId>();

  for (const row of rows) {
    // Create each unique product once (keyed by name)
    let productId = productIds.get(row.product_name);
    if (!productId) {
      const created = await quickCreateProduct(
        db,
        {
          name: row.product_name,
          manufacturer: row.manufacturer ?? "(unspecified)",
          upc: row.upc ?? null,
          expectedQuantity: row.expected_qty ?? null,
          price: row.price ?? null,
        },
        actor,
      );
      productId = productIdSchema.parse(created.id);
      productIds.set(row.product_name, productId);
    }

    // Place inventory only when a location is given (else it's a product-only row)
    if (row.location_name) {
      let locationId = locationIds.get(row.location_name);
      if (!locationId) {
        const loc = await findOrCreateLocationByName(
          db,
          row.location_name,
          null, // parentId - test locations are roots
          "room", // type - default to room for test locations
        );
        locationId = loc.locationId;
        locationIds.set(row.location_name, locationId);
      }

      await createInventoryEntry(
        db,
        {
          productId,
          locationId,
          amount: { value: row.quantity ?? 1, unit: row.unit ?? "each" },
        },
        actor,
      );
    }
  }

  // Query created inventory entries to build the "productName@locationName" map
  // (createInventoryEntry doesn't return a name-keyed lookup)
  const inventoryEntries = await inventoryentryList(
    db,
    {},
    { orderBy: "createdAt", direction: "asc" },
    { pageIndex: 0, pageSize: MAX_PAGE_SIZE },
  );

  for (const entry of inventoryEntries.data) {
    const key = `${entry.product.name}@${entry.location.name}`;
    inventoryIds.set(key, inventoryIdSchema.parse(entry.id));
  }

  return { productIds, locationIds, inventoryIds };
}

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ActorContext,
  type AuditSource,
  buildActorContext,
} from "@cubby/schemas/context";
import {
  type InventoryShortcode,
  type LocationId,
  type LocationShortcode,
  type ProductId,
  type ProductShortcode,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeUserId,
} from "@cubby/schemas/identifiers";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { beforeEach } from "vitest";
import type { Database } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { ensureDbExtensions } from "./db-extensions";

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

let hash = "";

/**
 * Test-only SQL counter.  It wraps the file-local pool at its lowest shared
 * point, so it sees both ordinary `pool.query()` calls and the checked-out
 * client queries used by `withConnection()`.  The async scope makes parallel
 * work within a lane count correctly without leaking setup/fixture SQL into a
 * measurement.
 */
const queryMeasurement = new AsyncLocalStorage<{ count: number }>();
const QUERY_COUNTED = Symbol("test-query-counted");

type QueryCountedClient = {
  query: (...args: unknown[]) => unknown;
  [QUERY_COUNTED]?: boolean;
};

const countClientQueries = <T extends QueryCountedClient>(client: T): T => {
  if (client[QUERY_COUNTED]) return client;
  const query = client.query.bind(client);
  client.query = (...args: unknown[]) => {
    const measurement = queryMeasurement.getStore();
    if (measurement) measurement.count += 1;
    return query(...args);
  };
  client[QUERY_COUNTED] = true;
  return client;
};

const countPoolQueries = (pool: Pool): Pool => {
  const connect = pool.connect.bind(pool);
  pool.connect = ((...args: unknown[]) => {
    const callback = args[0];
    // `pool.query()` calls `connect(callback)` internally. Preserve that
    // overload exactly; awaiting it would turn its `undefined` return into the
    // "client" and break every ordinary Drizzle query.
    if (typeof callback === "function") {
      return connect((error, client, done) =>
        callback(
          error,
          client
            ? (countClientQueries(
                client as unknown as QueryCountedClient,
              ) as typeof client)
            : client,
          done,
        ),
      );
    }
    return connect().then(
      (client) =>
        countClientQueries(
          client as unknown as QueryCountedClient,
        ) as typeof client,
    );
  }) as typeof pool.connect;
  return pool;
};

/**
 * Count SQL statements issued by one operation against this integration
 * file's database.  This deliberately measures statements, not wall time:
 * CI and a shared local PostgreSQL instance make time budgets flaky, while an
 * accidental per-row query is deterministic and actionable.
 */
export async function countTestDbQueries<T>(
  run: () => Promise<T>,
): Promise<{ result: T; queryCount: number }> {
  const measurement = { count: 0 };
  const result = await queryMeasurement.run(measurement, run);
  return { result, queryCount: measurement.count };
}

// Standard test IDs used across all tests
export const TEST_USER_ID = "test-user-id";
export const TEST_HOME_ID = unsafeLocationId(
  "00000000-0000-4000-8000-000000000001",
);
export const TEST_HOME_SHORTCODE = unsafeLocationShortcode("LOC-HM3E");

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
 *
 * Both schema files must be hashed. schema.ts is what `pushSchema` is pointed
 * at, but it re-exports every better-auth table from auth.schema.ts, so those
 * tables are in the template too. Hashing schema.ts alone meant an auth.schema.ts
 * edit reused a **stale template**: the column existed in TS and not in the test
 * database, and every test failed with a confusing `column ... does not exist`
 * from the seed step rather than from the code under test. (CI hides this — a
 * fresh container has no cached template to go stale.)
 */
async function getTemplateHash(): Promise<string> {
  return integreSQL.hashFiles([
    "./src/server/db/schema.ts",
    "./src/server/db/auth.schema.ts",
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

    console.log("Pushing schema to template database");
    const pool = new Pool({ connectionString: connectionUrl });
    const db = drizzle(pool);

    try {
      // Imported lazily, and deliberately. `pushSchema` is only ever needed
      // HERE, in `setup()` — which is the integration project's `globalSetup`
      // and so runs once per `vitest run`. But this module is also reached by
      // every one of the 69 integration test files, because
      // `tooling/integration-teardown.ts` (a `setupFiles` entry) imports
      // `closeTestDb` from it. A top-level import therefore loaded the whole
      // 9.8 MB drizzle-kit migration engine 69 times to use it once: measured
      // **565ms per file**, ~39s of cumulative worker time. Keep this dynamic.
      const { pushSchema } = await import("drizzle-kit/api");

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
/**
 * The one row the template does not carry. `AuditLog.userId` is NOT NULL ->
 * `user.id` and virtually every repo mutation writes an audit row, so this must
 * exist before any test body runs — including after each reset.
 */
async function seedTestUser(rawDb: ReturnType<typeof drizzle>) {
  await rawDb.insert(schema.user).values({
    id: TEST_USER_ID,
    name: "Test User",
    email: "test@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Every integration database starts with Cubby's one real hierarchy root. */
async function seedTestHome(rawDb: ReturnType<typeof drizzle>) {
  await rawDb.insert(schema.location).values({
    id: TEST_HOME_ID,
    shortcode: TEST_HOME_SHORTCODE,
    name: "Home",
    aliases: [],
    type: "house",
    parentId: null,
  });
}

/**
 * The database for THIS test file.
 *
 * Vitest runs the integration project with the forks pool and `isolate: true`,
 * so each test file gets its own module registry — this cache is therefore
 * per-file, not per-worker. That is deliberate: several suites read global
 * "zero" invariants (`findOrphanedEntityEmbeddings`) and recent-N windows
 * (`listBackgroundBatches`) that are only meaningful within one file.
 */
let fileDb: {
  db: Database;
  rawDb: ReturnType<typeof drizzle>;
  pool: Pool;
  /** IntegreSQL's pool slot for this database, for {@link closeTestDb}. */
  testId: number;
} | null = null;

/** `TRUNCATE` target list, resolved once per file (see {@link resetTestDb}). */
let truncateTargets = "";

/**
 * Hand the database back so IntegreSQL drops and recreates it from the template.
 *
 * This is NOT optional bookkeeping. IntegreSQL serves a fixed ring of databases
 * (16 by default) and, told nothing, eventually re-hands one that is still in
 * use. Under the old per-test model a database was held for milliseconds and
 * that rarely bit; holding one for a whole file makes it certain — two parallel
 * files get the same database and the second one's seed dies on
 * `duplicate key ... "user_pkey"`. Releasing here keeps the ring honest.
 *
 * `recreate` (not `reuse`) because we have dirtied it.
 *
 * The status check is load-bearing: `fetch` only rejects on a network error, so
 * a 404/500 (stale `testId`, hash mismatch) would resolve normally and leave a
 * dirty database in the ring — resurfacing as `duplicate key ... "user_pkey"` in
 * some unrelated file later. Fail here, where the cause is still legible.
 */
async function releaseTestDb(testId: number) {
  const hash = await getTemplateHash();
  const url = `http://localhost:5000/api/v1/templates/${hash}/tests/${testId}/recreate`;
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    throw new Error(
      `test-setup: failed to release IntegreSQL database ${testId} (${response.status} ${response.statusText}). ` +
        "It will be re-handed to another test file while still dirty. " +
        `Body: ${await response.text().catch(() => "<unreadable>")}`,
    );
  }
}

async function getFileDb() {
  if (fileDb) return fileDb;

  const databaseConfig = await integreSQL.getTestDatabase(
    await getTemplateHash(),
  );
  // The high-level client drops the numeric pool id, so recover it from the
  // database name (`integresql_test_<hash>_007`) — we need it to release.
  const testId = Number(/_(\d+)$/.exec(databaseConfig.database)?.[1]);
  if (!Number.isInteger(testId)) {
    throw new Error(
      `test-setup: could not parse an IntegreSQL pool id from "${databaseConfig.database}"`,
    );
  }
  const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
    remapDBConfig(databaseConfig),
  );
  const pool = countPoolQueries(new Pool({ connectionString: connectionUrl }));
  // `resetTestDb` terminates this pool's own idle backends; node-postgres
  // surfaces that as an 'error' on the idle client, and an unhandled one takes
  // the whole worker down. Swallow it — the pool just opens a fresh connection.
  pool.on("error", () => {});
  const rawDb = drizzle({ client: pool, schema });

  // Derived from the live database rather than hardcoded, so a new table in
  // schema.ts is cleaned automatically. A stale hardcoded list would silently
  // leak rows between tests — the exact bug this whole mechanism exists to
  // prevent — and nothing would fail loudly enough to notice.
  const { rows } = await pool.query<{ list: string | null }>(
    `SELECT string_agg(format('%I', tablename), ', ') AS list
       FROM pg_tables WHERE schemaname = 'public'`,
  );
  truncateTargets = rows[0]?.list ?? "";
  if (!truncateTargets) {
    throw new Error(
      "test-setup: found no public tables to truncate — is the IntegreSQL template schema pushed?",
    );
  }

  fileDb = { db: rawDb as unknown as Database, rawDb, pool, testId };
  return fileDb;
}

/**
 * Restore the pristine-database contract between tests.
 *
 * One statement clears all 40 tables: ordering doesn't matter (the only cycles
 * are the self-FKs on `Project.parentProjectId` / `Task.parentTaskId`, which are
 * irrelevant when the whole table goes), and `RESTART IDENTITY` is a no-op since
 * every PK is a UUID or a client-generated text id. Crucially the ~177 indexes,
 * 7 enum types and 2 extensions all survive — that is precisely the per-database
 * work a `CREATE DATABASE ... TEMPLATE` was repeating for all 294 tests.
 *
 * Re-measured 2026-08-17 after docker-compose.yml was tuned for tests
 * (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`, statement
 * logging off) and the 1603 leaked IntegreSQL databases were dropped. Both
 * halves of the original trade-off moved, and the conclusion survives:
 *
 *   - a fresh `getTestDatabase()` per test: **777ms -> 34ms**
 *   - this TRUNCATE-all reset:             **266ms -> 31ms**
 *
 * So per-test databases are no longer disqualified on cost — they are simply a
 * tie, and a tie does not justify rewriting `withTestDb()`. Note also that the
 * 34ms was measured sequentially; under the real 8-way parallel run the binding
 * constraint is IntegreSQL refilling its pool, which is what the original 777ms
 * actually captured. Don't re-open this on a single-threaded microbenchmark.
 *
 * ⚠️ Truncating only the DIRTY tables (`pg_stat_user_tables` where
 * `n_tup_ins + n_tup_upd + n_tup_del > 0`) looks like a 10x win and is NOT
 * SAFE. Those counters are not synchronous: measured on PG17, a table INSERTed
 * into reports `(NONE)` when queried immediately afterwards and only appears
 * ~2s later. A reset built on them silently skips the tables the previous test
 * just wrote — row leakage between tests, which is the exact failure this
 * function exists to prevent, and it would fail as a confusing duplicate-key
 * error in some unrelated later test rather than here.
 */
async function resetTestDb() {
  const { rawDb, pool } = await getFileDb();

  // Evict every other connection to this database first. TRUNCATE needs
  // ACCESS EXCLUSIVE on all 40 tables, and the file's pool is now shared across
  // tests — so a fire-and-forget background job still writing from the previous
  // test holds a lock and TRUNCATE waits behind it until the hook times out.
  // (That failure is self-propagating: the blocked reset never clears `user`,
  // so the *next* test dies on `duplicate key ... "user_pkey"` instead.)
  // Nothing legitimate is in flight between tests, so killing those backends is
  // exactly right — and it is what the per-test database used to do implicitly
  // by simply never reusing a connection.
  await pool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  await pool.query(`TRUNCATE ${truncateTargets} RESTART IDENTITY CASCADE`);
  await seedTestUser(rawDb);
  await seedTestHome(rawDb);
}

/** Holder returned by {@link withTestDb}; fields are live before each test. */
export interface TestDbContext {
  db: Database;
  actor: ActorContext;
}

/**
 * Release this file's database. Registered as a FILE-level `afterAll` by
 * `tooling/integration-teardown.ts` (a vitest `setupFiles` entry).
 *
 * It deliberately does not live in `withTestDb()`: that runs inside a
 * `describe`, so its `afterAll` would fire when the first describe ends — and
 * files here declare up to 9 — dropping the cached database mid-file. Later
 * describes would then re-provision (49 provisions instead of 35, measured) and
 * their databases would never be handed back.
 */
export async function closeTestDb() {
  if (!fileDb) return;
  const { pool, testId } = fileDb;
  fileDb = null;
  truncateTargets = "";
  await pool.end();
  await releaseTestDb(testId);
}

/**
 * Per-test database scaffold. Call once at the top of a `describe`: it registers
 * a `beforeEach` that hands back a pristine database, and returns a holder whose
 * `.db`/`.actor` are populated before each test body runs.
 *
 * ```ts
 * const ctx = withTestDb();
 * it("creates a product", async () => {
 *   await createProduct(ctx.db, makeProductInput(), ctx.actor);
 * });
 * ```
 *
 * Every test starts from the same two baseline rows (the test user and Home), so
 * domain tables other than Location remain empty and uniqueness behavior stays
 * deterministic. What changed is *how* that is achieved: the file provisions ONE IntegreSQL database
 * and truncates between tests, instead of paying a `CREATE DATABASE ...
 * TEMPLATE` per test. See {@link resetTestDb}.
 *
 * Pass `source` for suites that audit as something other than the UI (the
 * cookbook/EPUB importers stamp `"epub_import"`).
 */
export function withTestDb(source: AuditSource = "ui"): TestDbContext {
  const actor = buildActorContext(unsafeUserId(TEST_USER_ID), source);
  // `db` is assigned in the beforeEach below before any test reads it; the cast
  // keeps call sites free of an `undefined` union they'd otherwise have to narrow.
  const ctx: TestDbContext = {
    db: undefined as unknown as Database,
    actor,
  };

  beforeEach(async () => {
    await resetTestDb();
    ctx.db = (await getFileDb()).db;
    ctx.actor = actor;
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
  productIds: Map<string, ProductShortcode>;
  locationIds: Map<string, LocationShortcode>;
  inventoryIds: Map<string, InventoryShortcode>;
}

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
  const { createInventoryEntry } = await import("../src/server/repo/inventory");
  const { quickCreateProduct } = await import("../src/server/repo/product");
  const { findOrCreateLocationByName, getLocationById } = await import(
    "../src/server/repo/location"
  );
  const { resolveLiveShortcode } = await import(
    "../src/server/repo/shortcode-resolver"
  );

  const productIds = new Map<string, ProductShortcode>();
  const productEntityIds = new Map<string, ProductId>();
  const locationIds = new Map<string, LocationShortcode>();
  const locationEntityIds = new Map<string, LocationId>();
  const inventoryIds = new Map<string, InventoryShortcode>();

  for (const row of rows) {
    // Create each unique product once (keyed by name)
    let productId = productEntityIds.get(row.product_name);
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
      const resolved = await resolveLiveShortcode(db, created.id, "product");
      if (!resolved) throw new Error("seedFromCSV: created product not found");
      productId = resolved as ProductId;
      productEntityIds.set(row.product_name, productId);
      productIds.set(row.product_name, created.id);
    }

    // Place inventory only when a location is given (else it's a product-only row)
    if (row.location_name) {
      let locationId = locationEntityIds.get(row.location_name);
      if (!locationId) {
        const loc = await findOrCreateLocationByName(
          db,
          row.location_name,
          TEST_HOME_ID,
          "room", // type - default to room for test locations
        );
        locationId = loc.locationId;
        locationEntityIds.set(row.location_name, locationId);
        locationIds.set(
          row.location_name,
          (await getLocationById(db, locationId))!.id,
        );
      }

      const created = await createInventoryEntry(
        db,
        {
          productId,
          locationId,
          amount: { value: row.quantity ?? 1, unit: row.unit ?? "each" },
        },
        actor,
      );
      inventoryIds.set(`${row.product_name}@${row.location_name}`, created.id);
    }
  }

  return { productIds, locationIds, inventoryIds };
}

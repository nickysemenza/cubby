import { testServiceConfig } from "./test-service-config";
import { schemaTemplateInputs } from "./schema-template-inputs";
import { taxonomyRootFixtures } from "./product-category-fixtures";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ActorContext,
  type AuditChannel,
  buildActorContext,
} from "@cubby/schemas/context";
import {
  testEntityId,
  testShortcode,
  testUserId,
} from "@cubby/schemas/testing";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { beforeEach } from "vitest";
import {
  Database,
  type DatabaseClient,
  type DatabaseRuntime,
} from "../src/server/db/database";
import {
  observePgPoolAndClientQueries,
  tracePool,
} from "../src/server/db-pg-tracing";
import * as schema from "../src/server/db/schema";
import type {
  EntityCreateInput,
  EntityKernelContext,
  EntityPublicOutput,
} from "../src/server/entity-kernel/adapter";
import type { EntityKernelEntity } from "../src/server/entity-kernel/contracts";
import { ensureDbExtensions } from "./db-extensions";
import { toPushSchemaDatabase } from "./drizzle-kit-interop";
import { z } from "zod";

let client: IntegreSQLClient | undefined;
const getIntegreSQL = () =>
  (client ??= new IntegreSQLClient({ url: testServiceConfig().url }));

const toTestDatabase = (
  value: DatabaseClient | Database,
  pool: Pool,
): Database => {
  if (value instanceof Database) return value;
  const runtime: DatabaseRuntime = {
    client: value,
    withConnection: async (fn) => {
      const connection = await pool.connect();
      try {
        return await fn(drizzle({ client: connection, schema }));
      } finally {
        connection.release();
      }
    },
  };
  return new Database(() => runtime);
};

let hash = "";

/**
 * Test-only SQL counter.  It wraps the file-local pool at its lowest shared
 * point, so it sees both ordinary `pool.query()` calls and the checked-out
 * client queries used by `withConnection()`.  The async scope makes parallel
 * work within a lane count correctly without leaking setup/fixture SQL into a
 * measurement.
 */
interface QueryMeasurement {
  count: number;
  statements: string[];
}

const queryMeasurement = new AsyncLocalStorage<QueryMeasurement>();

const countObservedStatement = (text: string) => {
  const measurement = queryMeasurement.getStore();
  if (!measurement) return;
  measurement.count += 1;
  // Normalize in-list arity (`in ($1, $2, …)` → `in (…)`) so a diff of
  // two measurements compares statement SHAPES, not page sizes.
  measurement.statements.push(
    text
      .replace(/\s+/g, " ")
      .replace(/\(\s*\$\d+(?:\s*,\s*\$\d+)*\s*\)/g, "(…)")
      .slice(0, 160),
  );
};

// tracePool is the production wrapper (it serializes each connection's
// queries); counting sits on top so it sees the same statements as before.
const countPoolQueries = (pool: Pool): Pool =>
  observePgPoolAndClientQueries(
    tracePool(pool, "strong"),
    countObservedStatement,
  );

/**
 * Count SQL statements issued by one operation against this integration
 * file's database.  This deliberately measures statements, not wall time:
 * CI and a shared local PostgreSQL instance make time budgets flaky, while an
 * accidental per-row query is deterministic and actionable.
 */
export async function countTestDbQueries<T>(
  run: () => Promise<T>,
): Promise<{ result: T; queryCount: number; statements: string[] }> {
  const measurement = {
    count: 0,
    statements: [],
  } satisfies QueryMeasurement;
  const result = await queryMeasurement.run(measurement, run);
  return {
    result,
    queryCount: measurement.count,
    statements: measurement.statements,
  };
}

export const TEST_USER_ID = "test-user-id";
export const TEST_HOME_ID = testEntityId(
  "location",
  "00000000-0000-4000-8000-000000000001",
);
export const TEST_HOME_SHORTCODE = testShortcode("location", "LOC-HM3E");

/**
 * The authenticated actor every integration test runs as. Mirrors what
 * `buildTestDB()` returns — import this instead of redefining a local
 * `TEST_ACTOR` (or `testUserId("test-user-id")`) per file.
 */
export const TEST_ACTOR: ActorContext = buildActorContext(
  testUserId(TEST_USER_ID),
);

async function getTemplateHash(): Promise<string> {
  return getIntegreSQL().hashFiles(schemaTemplateInputs);
}

export async function setup() {
  console.log("TEST GLOBAL SETUP");
  hash = await getTemplateHash();

  // Initialize the template database
  await getIntegreSQL().initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = getIntegreSQL().databaseConfigToConnectionUrl(
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
      const { apply } = await pushSchema(schema, toPushSchemaDatabase(db), [
        "public",
      ]);
      await apply();
      // drizzle-kit push does not manage triggers (ADR 0006).
      await schema.installEntityIdentityTriggers(db);
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

/** Stable taxonomy roots give test Product writes the same behavior bindings. */
async function seedTestProductCategories(rawDb: ReturnType<typeof drizzle>) {
  await rawDb.insert(schema.productCategory).values(taxonomyRootFixtures);
}

/**
 * The database for THIS test file.
 *
 * Vitest runs the integration project with the forks pool and `isolate:
 * false`, so the JS module registry is shared across every file a worker
 * runs — this variable itself would leak across files in the same worker if
 * nothing reset it. It doesn't: `tooling/integration-teardown.ts` registers a
 * FILE-scoped `afterAll` (setupFiles run fresh per file even when the module
 * graph is shared) that calls {@link closeTestDb}, which sets `fileDb = null`
 * before the next file in the worker can call {@link getFileDb} again. So
 * this cache is file-scoped in effect, not because the registry is fresh, but
 * because it is explicitly torn down. That distinction matters for anything
 * that ISN'T reset here — a true per-worker module singleton (`db.ts`'s
 * `moduleRuntime` pool, `cf-env.ts`, `clients/ai.ts`, `ai/models.ts`,
 * `semantic/embeddings.ts`, `clients/notion.ts`'s LRU caches) now persists
 * across files in the same worker, which is exactly what several suites'
 * global "zero" invariants (`findOrphanedEntityEmbeddings`) and recent-N
 * windows (`listBackgroundBatches`) rely on NOT happening — they stay correct
 * only because they scope by `TEST_HOME_ID`/`TEST_USER_ID` rows that
 * `resetTestDb()` truncates every test, not because the module graph resets.
 */
let fileDb: {
  db: Database;
  databaseUrl: string;
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
  const url = `${testServiceConfig().url}/api/v1/templates/${hash}/tests/${testId}/recreate`;
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

  const databaseConfig = await getIntegreSQL().getTestDatabase(
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
  const connectionUrl = getIntegreSQL().databaseConfigToConnectionUrl(
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

  fileDb = {
    db: toTestDatabase(rawDb, pool),
    databaseUrl: connectionUrl,
    rawDb,
    pool,
    testId,
  };
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
 * Measured with docker-compose.yml tuned for tests (`fsync=off`,
 * `synchronous_commit=off`, `full_page_writes=off`, statement logging off)
 * and no leaked IntegreSQL databases dragging on the pool. Both halves of the
 * original trade-off moved, and the conclusion survives:
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
  await seedTestProductCategories(rawDb);
  return (await getFileDb()).db;
}

/** Holder returned by {@link withTestDb}; fields are live before each test. */
export interface TestDbContext {
  db: Database;
  /** Isolated IntegreSQL URL for a workerd Worker/Hyperdrive test binding. */
  databaseUrl: string;
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
export function withTestDb(channel: AuditChannel = "web"): TestDbContext {
  const actor = buildActorContext(testUserId(TEST_USER_ID), channel);
  interface TestDbState {
    db: Database | null;
  }
  const state: TestDbState = { db: null };
  const ctx: TestDbContext = {
    get db() {
      if (!state.db) {
        throw new Error("withTestDb database is unavailable before beforeEach");
      }
      return state.db;
    },
    get databaseUrl() {
      if (!state.db) {
        throw new Error("withTestDb database is unavailable before beforeEach");
      }
      return fileDb?.databaseUrl ?? "";
    },
    actor,
  };

  beforeEach(async () => {
    state.db = await resetTestDb();
    ctx.actor = actor;
  });
  return ctx;
}

const LOCK_POLL_INTERVAL_MS = 50;
const LOCK_POLL_TIMEOUT_MS = 5_000;

/**
 * Poll until some other session on this test's database is blocked waiting
 * on a lock. Bounded at 5s (polled every ~50ms) so a broken lock path fails
 * fast with a clear message instead of hanging the test.
 */
async function waitForLockWaiter(db: Database): Promise<void> {
  // Lazy: this module is also vitest's `globalSetup`, which runs in the main
  // process before `test.env` applies, and `database-helpers/core` pulls in
  // `env.ts`, whose validation would fail there.
  // oxlint-disable-next-line no-restricted-imports -- lazy by design, see above
  const { getDb } = await import("../src/server/repo/database-helpers/core");
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  for (;;) {
    const result = await getDb(db).execute(sql`
      SELECT count(*) AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `);
    const waiting = Number(result.rows[0]?.count ?? 0);
    if (waiting > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        "raceUniqueInsert: no session started waiting on a lock within " +
          `${LOCK_POLL_TIMEOUT_MS}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
}

/**
 * Deterministically forces a unique-row race between two concurrent
 * operations, for the "recovers from a concurrent create race instead of
 * 500ing" integration tests. Replaces the fixed `setTimeout` pairs those
 * tests used to force the race with a poll on real lock contention.
 *
 * `winner(releaseSignal)` must open a transaction, perform its INSERT (or
 * equivalent), call `markWinnerReady`, then await `releaseSignal` while still
 * inside that transaction — holding the row lock open — and only then return
 * (which commits). `loser()` starts only after that explicit handshake, so it
 * is expected to block on the row lock `winner` is holding. This polls
 * `pg_stat_activity` for a session on this test's database actually waiting on
 * a lock (the loser having reached its blocked INSERT) before resolving
 * `releaseSignal`, instead of guessing with scheduling or sleeps.
 */
export async function raceUniqueInsert<TWinner, TLoser>(
  ctx: TestDbContext,
  args: {
    winner: (controls: {
      releaseSignal: Promise<void>;
      markWinnerReady: () => void;
    }) => Promise<TWinner>;
    loser: () => Promise<TLoser>;
  },
): Promise<{ winner: TWinner; loser: TLoser }> {
  let release!: () => void;
  const releaseSignal = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markWinnerReady!: () => void;
  const winnerReady = new Promise<void>((resolve) => {
    markWinnerReady = resolve;
  });

  const winnerPromise = args.winner({ releaseSignal, markWinnerReady });
  let loserPromise: Promise<TLoser> | undefined;

  try {
    await Promise.race([
      winnerReady,
      winnerPromise.then(() => {
        throw new Error("raceUniqueInsert: winner completed before ready");
      }),
    ]);
    loserPromise = args.loser();
    await Promise.race([
      waitForLockWaiter(ctx.db),
      loserPromise.then(() => {
        throw new Error("raceUniqueInsert: loser completed before blocking");
      }),
    ]);
    release();

    const [winnerResult, loserResult] = await Promise.all([
      winnerPromise,
      loserPromise,
    ]);
    return { winner: winnerResult, loser: loserResult };
  } finally {
    // If either assertion above fails, unblock the live transaction before the
    // file teardown returns its database to IntegreSQL.
    release();
    await Promise.allSettled(
      loserPromise ? [winnerPromise, loserPromise] : [winnerPromise],
    );
  }
}

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  const { host, port } = testServiceConfig();
  databaseConfig.host = host;
  databaseConfig.port = port;
  return databaseConfig;
};

// NOTE: We use dynamic imports for repo modules to avoid loading env.js
// during vitest globalSetup phase (before test.env variables are applied)

type SeedOverrides<E extends EntityKernelEntity> = Partial<
  EntityCreateInput<E>
>;
export async function seedEntity<E extends EntityKernelEntity>(
  db: Database,
  entity: E,
  overrides?: SeedOverrides<E>,
): Promise<EntityPublicOutput<E>> {
  const [
    { mock },
    { parseEntityPublicOutput },
    { createTestRequestContext },
    { requireActor },
    { generatedEntityMutationCreateResultSchema },
    { ENTITY_KERNEL_BINDINGS, ENTITY_KERNEL_OPERATIONS },
    { ENTITY_KERNEL_ENTITIES },
  ] = await Promise.all([
    import("../src/lib/test/mock-schema"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/entity-kernel/adapter"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/testing/request-context"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/request-context"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/generated/entity-bindings.gen"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/generated/entity-kernel-bindings.gen"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/entity-kernel/contracts"),
  ]);

  const entityKernelEntitySchema = z.enum(ENTITY_KERNEL_ENTITIES);
  entityKernelEntitySchema.parse(entity);
  const binding = ENTITY_KERNEL_BINDINGS[entity];
  if (!binding.schemas.createInput || !binding.repository.create) {
    throw new Error(`seedEntity: "${entity}" is not kernel-creatable`);
  }

  const input = mock(binding.schemas.createInput, { overrides });
  const baseContext = createTestRequestContext(db, {
    auth: { userId: testUserId("test-user-id") },
  });
  const context: EntityKernelContext = requireActor(baseContext);
  const created = await ENTITY_KERNEL_OPERATIONS[entity].create(context, input);
  const createdResult =
    generatedEntityMutationCreateResultSchema.parse(created);
  return parseEntityPublicOutput(entity, createdResult.item);
}

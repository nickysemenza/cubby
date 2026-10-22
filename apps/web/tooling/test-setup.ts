import {
  createDatabase,
  type DatabaseClient,
  type DatabaseRuntime,
} from "../src/server/db/database-runtime";
import {
  createPostgresPool,
  terminateOtherPostgresConnections,
} from "./postgres-pool";
import { pollUntil } from "@cubby/shared/retry";
import {
  type DatabaseLease,
  leaseDatabase,
  leaseTemplateDatabase,
  prepareTemplate,
} from "./test-database-lease";
import {
  prepareFixtureTemplate,
  setupFixtureRun,
  teardownFixtureRun,
} from "./test-fixture-template";
import type { TestProject } from "vitest/node";
import {
  BASE_HOME_ID,
  BASE_HOME_SHORTCODE,
  seedBaseWorld,
} from "./factories/base-world";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ActorContext,
  type AuditChannel,
  buildActorContext,
} from "@cubby/schemas/context";
import { testUserId } from "@cubby/schemas/testing";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { type Pool } from "pg";
import { afterEach, beforeEach, expect } from "vitest";
import { Database } from "../src/server/db/database";
import {
  observePgPoolAndClientQueries,
  tracePool,
} from "../src/server/db/db-pg-tracing";
import * as schema from "../src/server/db/schema";
import type {
  EntityCreateInput,
  EntityKernelContext,
  EntityPublicOutput,
} from "../src/server/entity-kernel/adapter";
import type { EntityKernelEntity } from "../src/server/entity-kernel/contracts";
import type { CreatableEntity, EntityOverrides } from "./factories/build";
import { z } from "zod";

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
  return createDatabase(() => runtime);
};

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
  tables: Set<string>;
}

const queryMeasurement = new AsyncLocalStorage<QueryMeasurement>();

const countObservedStatement = (text: string) => {
  const measurement = queryMeasurement.getStore();
  if (!measurement) return;
  measurement.count += 1;
  // Normalize in-list arity (`in ($1, $2, …)` → `in (…)`) so a diff of
  // two measurements compares statement SHAPES, not page sizes.
  // Inspect full SQL before shortening display excerpts: long SELECT lists must not hide dependent reads.
  for (const match of text.matchAll(
    /\b(?:FROM|JOIN|UPDATE|INTO)\s+"([A-Za-z][A-Za-z0-9_]*)"/giu,
  )) {
    if (match[1]) measurement.tables.add(match[1]);
  }
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
export async function countTestDbQueries<T>(run: () => Promise<T>): Promise<{
  result: T;
  queryCount: number;
  statements: string[];
  tables: string[];
}> {
  const measurement = {
    count: 0,
    statements: [],
    tables: new Set<string>(),
  } satisfies QueryMeasurement;
  const result = await queryMeasurement.run(measurement, run);
  return {
    result,
    queryCount: measurement.count,
    statements: measurement.statements,
    tables: [...measurement.tables].sort(),
  };
}

export const TEST_USER_ID = "test-user-id";
export const TEST_HOME_ID = BASE_HOME_ID;
export const TEST_HOME_SHORTCODE = BASE_HOME_SHORTCODE;

/**
 * The authenticated actor every integration test runs as. Mirrors what
 * `buildTestDB()` returns — import this instead of redefining a local
 * `TEST_ACTOR` (or `testUserId("test-user-id")`) per file.
 */
export const TEST_ACTOR: ActorContext = buildActorContext(
  testUserId(TEST_USER_ID),
);

/**
 * Vitest `globalSetup`: prepare the template every integration file leases
 * from, and name the run that owns {@link TestDbContext.fixture} templates.
 */
export async function setup(project: TestProject) {
  await prepareTemplate("vitest");
  const run = await setupFixtureRun(project);
  return () => teardownFixtureRun(run);
}

/**
 * The rows the template does not carry. `AuditLog.userId` is NOT NULL ->
 * `user.id` and virtually every repo mutation writes an audit row, so the test
 * user must exist before any test body runs — including after each reset.
 * `seedBaseWorld` seeds the reserved system user.
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
 * `resetTestDb()` clears before every test, not because the module graph resets.
 */
let fileDb: {
  db: Database;
  databaseUrl: string;
  rawDb: ReturnType<typeof drizzle>;
  pool: Pool;
  /** Released by {@link closeTestDb}. */
  lease: DatabaseLease;
} | null = null;

/** Reset statement, resolved once per file (see {@link resetTestDb}). */
let resetSql = "";

/**
 * Every public table, derived from the live database rather than hardcoded,
 * so a new table in schema.ts is cleaned automatically. A stale hardcoded list
 * would silently leak rows between tests — the exact bug this whole mechanism
 * exists to prevent — and nothing would fail loudly enough to notice.
 */
async function readResetSql(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT format('%I', tablename) AS name
       FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  if (!rows.length) {
    throw new Error(
      "test-setup: found no public tables to reset — is the IntegreSQL template migrated?",
    );
  }
  const tables = rows.map(({ name }) => name);
  // One statement (the query tracer expects a single result) and so one
  // transaction: the `set_config(..., true)` setting and the locks end at its
  // commit and never leak to the pooled connection.
  return [
    "DO $reset$ BEGIN",
    "PERFORM set_config('session_replication_role', 'replica', true);",
    `LOCK TABLE ${tables.join(", ")} IN ACCESS EXCLUSIVE MODE;`,
    ...tables.map((table) => `DELETE FROM ${table};`),
    "END $reset$",
  ].join("\n");
}

async function getFileDb() {
  if (fileDb) return fileDb;

  // Held for the whole file, so {@link closeTestDb} must release it: an
  // unreleased slot is re-handed to a parallel file while still in use.
  const {
    lease,
    prepared: { pool, reset },
  } = await leaseDatabase("vitest", async ({ databaseUrl }) => {
    // `resetTestDb` terminates this pool's own idle backends; node-postgres
    // surfaces that as an 'error' on the idle client, and an unhandled one
    // takes the whole worker down. `openTestPool` swallows it — the pool just
    // opens a fresh connection.
    const pool = openTestPool(databaseUrl);
    try {
      return { pool, reset: await readResetSql(pool) };
    } catch (error) {
      await pool.end();
      throw error;
    }
  });
  resetSql = reset;
  const rawDb = drizzle({ client: pool, schema });

  fileDb = {
    db: toTestDatabase(rawDb, pool),
    databaseUrl: lease.databaseUrl,
    rawDb,
    pool,
    lease,
  };
  return fileDb;
}

/**
 * Restore the pristine-database contract between tests.
 *
 * One implicit transaction empties every public table and leaves the schema,
 * indexes, enum types and extensions in place — the per-database work a
 * `CREATE DATABASE ... TEMPLATE` would repeat for every test.
 *
 * `DELETE`, not `TRUNCATE`: TRUNCATE gives every table, toast table and index a
 * new relfilenode (~850 relations for 106 tables) and broadcasts a relcache
 * invalidation for each, so its cost scales with the schema rather than the
 * handful of rows a test writes. On the shared container (PG17, durability
 * off) a TRUNCATE-all reset measured ~300ms of server CPU alone and ~800ms
 * with parallel workers; deleting from the same tables measured ~7ms. Most of
 * the integration suite's PostgreSQL CPU was this reset.
 *
 * `session_replication_role = replica` (superuser; every test database is owned
 * by `postgres`) disables FK and user triggers for the transaction, matching
 * TRUNCATE: deletion order is irrelevant, and row triggers such as
 * `assessment_history_immutable` — which rejects DELETE — never fire. No public
 * table owns a sequence, so there is no identity to restart. ACCESS EXCLUSIVE
 * locks keep TRUNCATE's wait for any transaction still open on these tables;
 * without them a straggler's uncommitted insert would commit after the DELETE
 * and leak into the next test.
 *
 * ⚠️ Resetting only the DIRTY tables (`pg_stat_user_tables` where
 * `n_tup_ins + n_tup_upd + n_tup_del > 0`) is NOT SAFE. Those counters are not
 * synchronous: measured on PG17, a table INSERTed into reports `(NONE)` when
 * queried immediately afterwards and only appears ~2s later. A reset built on
 * them silently skips the tables the previous test just wrote — row leakage
 * between tests, which is the exact failure this function exists to prevent,
 * and it would fail as a confusing duplicate-key error in some unrelated later
 * test rather than here.
 */
async function resetTestDb() {
  const { rawDb, pool } = await getFileDb();

  // Evict the selected owned sessions first; an unowned runtime must drain
  // before reset and fails with a lifecycle diagnostic. The reset takes
  // ACCESS EXCLUSIVE on every table, and the file's pool is shared across
  // tests — so a fire-and-forget background job still writing from the previous
  // test holds a lock and the reset waits behind it until the hook times out.
  // (That failure is self-propagating: the blocked reset never clears `user`,
  // so the *next* test dies on `duplicate key ... "user_pkey"` instead.)
  // Nothing legitimate is in flight between tests, so terminating that fixed
  // owned set is what the per-test database used to do implicitly
  // by simply never reusing a connection.
  await terminateOtherPostgresConnections(pool);
  await pool.query(resetSql);
  await seedTestUser(rawDb);
  await seedBaseWorld(rawDb);
  return (await getFileDb()).db;
}

/** What a fixture seed may return: it is stored in, and read back from, SQL. */
export type FixtureJson =
  | string
  | number
  | boolean
  | null
  | FixtureJson[]
  | { [key: string]: FixtureJson };

/** Holder returned by {@link withTestDb}; fields are live before each test. */
export interface TestDbContext {
  db: Database;
  /** Isolated IntegreSQL URL for a workerd Worker/Hyperdrive test binding. */
  databaseUrl: string;
  actor: ActorContext;
  /**
   * Switch this test to a fresh clone of `key`'s seeded template and return
   * the seed's result. The first call in the run seeds a template through
   * `seed` (on top of the baseline user and Home); every later call, in any
   * worker, clones it. Use it only when `seed` costs more than a clone
   * (~250 ms under parallel load); see `tooling/test-fixture-template.ts`.
   * `seed` must be deterministic for its key and close over nothing per-test.
   */
  fixture<T extends FixtureJson>(
    key: string,
    seed: (db: Database, actor: ActorContext) => Promise<T>,
  ): Promise<T>;
  /**
   * Seed `key`'s template from a `beforeAll`, so its one-time cost runs under
   * the hook timeout instead of inside the first test's budget. Pass the same
   * `seed` that {@link fixture} receives for the key.
   */
  prepareFixture<T extends FixtureJson>(
    key: string,
    seed: (db: Database, actor: ActorContext) => Promise<T>,
  ): Promise<void>;
}

/** A per-test clone of a fixture template, released after the test. */
interface FixtureDb {
  db: Database;
  databaseUrl: string;
  pool: Pool;
  lease: DatabaseLease;
}

function openTestPool(databaseUrl: string): Pool {
  const pool = countPoolQueries(
    createPostgresPool({ connectionString: databaseUrl }),
  );
  // See getFileDb: terminated idle backends surface as pool errors.
  pool.on("error", () => {});
  return pool;
}

async function closeFixtureDb(fixtureDb: FixtureDb | null) {
  if (!fixtureDb) return;
  try {
    await fixtureDb.pool.end();
  } finally {
    await fixtureDb.lease.close();
  }
}

/** The seeded template's IntegreSQL hash, seeding it on first use. */
function fixtureTemplate<T extends FixtureJson>(
  key: string,
  actor: ActorContext,
  seed: (db: Database, actor: ActorContext) => Promise<T>,
): Promise<string> {
  // Keys are file-scoped: workers share one module graph and one run.
  const scopedKey = `${expect.getState().testPath ?? ""}\0${key}`;
  return prepareFixtureTemplate(scopedKey, async (databaseUrl) => {
    const pool = openTestPool(databaseUrl);
    try {
      const rawDb = drizzle({ client: pool, schema });
      await seedTestUser(rawDb);
      await seedBaseWorld(rawDb);
      const value = await seed(toTestDatabase(rawDb, pool), actor);
      // Outside `public`, so the file reset and table scans never see it. One
      // statement per query: the traced pool expects a single result.
      await pool.query("CREATE SCHEMA cubby_test");
      await pool.query(
        "CREATE TABLE cubby_test.fixture (value jsonb NOT NULL)",
      );
      await pool.query("INSERT INTO cubby_test.fixture VALUES ($1)", [
        JSON.stringify(value),
      ]);
    } finally {
      await pool.end();
    }
  });
}

async function leaseFixtureDb<T extends FixtureJson>(
  key: string,
  actor: ActorContext,
  seed: (db: Database, actor: ActorContext) => Promise<T>,
): Promise<{ fixtureDb: FixtureDb; value: T }> {
  const hash = await fixtureTemplate(key, actor, seed);
  const { lease, prepared } = await leaseTemplateDatabase(
    hash,
    async ({ databaseUrl }) => {
      const pool = openTestPool(databaseUrl);
      try {
        const { rows } = await pool.query<{ value: T }>(
          "SELECT value FROM cubby_test.fixture",
        );
        const [row] = rows;
        if (!row || rows.length !== 1)
          throw new Error(`Fixture template ${key} has no stored result`);
        return { pool, value: row.value };
      } catch (error) {
        await pool.end();
        throw error;
      }
    },
  );
  const rawDb = drizzle({ client: prepared.pool, schema });
  return {
    fixtureDb: {
      db: toTestDatabase(rawDb, prepared.pool),
      databaseUrl: lease.databaseUrl,
      pool: prepared.pool,
      lease,
    },
    value: prepared.value,
  };
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
  const { pool, lease } = fileDb;
  fileDb = null;
  resetSql = "";
  // Release even when ending the pool fails: a held slot starves the ring.
  try {
    await pool.end();
  } finally {
    await lease.close();
  }
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
 * and empties every table between tests, instead of paying a `CREATE DATABASE ...
 * TEMPLATE` per test. See {@link resetTestDb}.
 *
 * Pass `source` for suites that audit as something other than the UI (the
 * cookbook/EPUB importers stamp `"epub_import"`).
 */
export function withTestDb(channel: AuditChannel = "web"): TestDbContext {
  const actor = buildActorContext(testUserId(TEST_USER_ID), channel);
  interface TestDbState {
    db: Database | null;
    fixtureDb: FixtureDb | null;
    /**
     * An acquisition still in flight. A test that times out mid-seed leaves it
     * running; teardown waits for it and closes whatever it produces, so a
     * late clone never leaks or attaches to the next test.
     */
    acquiring: Promise<FixtureDb | null> | null;
  }
  const state: TestDbState = { db: null, fixtureDb: null, acquiring: null };
  const ctx: TestDbContext = {
    get db() {
      if (!state.db) {
        throw new Error("withTestDb database is unavailable before beforeEach");
      }
      return state.fixtureDb?.db ?? state.db;
    },
    get databaseUrl() {
      if (!state.db) {
        throw new Error("withTestDb database is unavailable before beforeEach");
      }
      return state.fixtureDb?.databaseUrl ?? fileDb?.databaseUrl ?? "";
    },
    actor,
    async prepareFixture(key, seed) {
      await fixtureTemplate(key, actor, seed);
    },
    async fixture(key, seed) {
      if (!state.db) {
        throw new Error("withTestDb fixture is unavailable before beforeEach");
      }
      if (state.fixtureDb || state.acquiring) {
        throw new Error("withTestDb fixture is already active for this test");
      }
      const acquisition = leaseFixtureDb(key, actor, seed);
      const acquiring = acquisition.then(
        ({ fixtureDb }) => fixtureDb,
        () => null,
      );
      state.acquiring = acquiring;
      const { fixtureDb, value } = await acquisition;
      // Teardown already claimed (and closes) this acquisition: the test timed
      // out. Stop its body rather than let it continue on the file database.
      if (state.acquiring !== acquiring)
        throw new Error(
          `withTestDb fixture ${key} resolved after its test ended`,
        );
      state.acquiring = null;
      state.fixtureDb = fixtureDb;
      return value;
    },
  };

  beforeEach(async () => {
    state.db = await resetTestDb();
    ctx.actor = actor;
  });
  afterEach(async () => {
    const { fixtureDb, acquiring } = state;
    state.fixtureDb = null;
    state.acquiring = null;
    await closeFixtureDb(fixtureDb);
    await closeFixtureDb(acquiring ? await acquiring : null);
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
  // process before `test.env` applies, and `db/helpers/core` pulls in
  // `env.ts`, whose validation would fail there.
  // oxlint-disable-next-line no-restricted-imports -- lazy by design, see above
  const { getDb } = await import("../src/server/db/helpers/core");
  await pollUntil(
    async () => {
      const result = await getDb(db).execute(sql`
        SELECT count(*) AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `);
      return Number(result.rows[0]?.count ?? 0) > 0 ? true : undefined;
    },
    {
      label: "raceUniqueInsert: a session waiting on a lock",
      timeoutMs: LOCK_POLL_TIMEOUT_MS,
      intervalMs: LOCK_POLL_INTERVAL_MS,
    },
  );
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
    { buildEntity },
    { parseEntityPublicOutput },
    { createTestRequestContext },
    { requireActor },
    { generatedEntityMutationCreateResultSchema },
    { ENTITY_KERNEL_BINDINGS, ENTITY_KERNEL_OPERATIONS },
    { ENTITY_KERNEL_ENTITIES },
  ] = await Promise.all([
    import("./factories/build"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/entity-kernel/adapter"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/testing/request-context"),
    // oxlint-disable-next-line no-restricted-imports -- lazy by design, see note above
    import("../src/server/http/request-context"),
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

  // SAFETY: the guard above proved this entity has a create input, which is
  // exactly what makes it a factory-creatable entity; `overrides` is a sparse
  // patch over that same create input.
  const input = buildEntity(
    entity as CreatableEntity,
    overrides as EntityOverrides<CreatableEntity>,
  );
  const baseContext = createTestRequestContext(db, {
    auth: { userId: testUserId("test-user-id") },
  });
  const context: EntityKernelContext = requireActor(baseContext);
  const created = await ENTITY_KERNEL_OPERATIONS[entity].create(context, {
    data: input,
  });
  const createdResult =
    generatedEntityMutationCreateResultSchema.parse(created);
  // Fixtures needing a full record read it explicitly; mutation receipts only
  // carry saved fields and cannot satisfy the detail contract.
  const detail = await ENTITY_KERNEL_OPERATIONS[entity].get(context, {
    id: createdResult.item.id,
    missing: "error",
  });
  if (!("item" in detail))
    throw new Error("Synthetic fixture detail was not returned");
  return parseEntityPublicOutput(entity, detail.item);
}

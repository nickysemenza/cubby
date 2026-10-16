import { createPostgresPool } from "./postgres-pool";
import { createHash } from "node:crypto";
import { IntegreSQLClient } from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { migrateDatabase } from "./db-migrate";
import { initializeRecoverableTemplate } from "./template-recovery";
import { cloneSchemaTemplate } from "./schema-template";
import { hashSchemaTemplateInputs } from "./schema-template-inputs";
import {
  assertSimulatorAdminUrl,
  assertSimulatorDatabaseName,
} from "./sim-db-guard";
import { testServiceConfig } from "./test-service-config";
import { worktreeRoot } from "../../../scripts/lib/harness-lock.ts";

/**
 * Disposable databases for Vitest, browser E2E and native runners.
 * IntegreSQL serves the Vitest integration tier and browser E2E workers;
 * guarded named databases serve native fixtures. The adapters (`tooling/test-setup.ts`,
 * `tests/e2e/support/e2e-database.ts`) keep their own seeding and reset policies;
 * this module owns template preparation, checkout, and release.
 *
 * Browser acceptance and Vitest share one IntegreSQL service (every worktree's
 * runs use one local pair). Each namespace gets its own template, so one
 * process's template initialization cannot invalidate a database the other
 * has checked out.
 */
type TemplateNamespace = "vitest" | "browser" | "migration";

export interface DatabaseLease {
  /** The disposable database name (pooled or named native fixture). */
  name: string;
  databaseUrl: string;
  /**
   * Release the database according to its backend and retention policy.
   * Idempotent: every call shares the first release.
   */
  close(): Promise<void>;
}

let client: IntegreSQLClient | undefined;
const integreSQL = () =>
  (client ??= new IntegreSQLClient({ url: testServiceConfig().url }));

/**
 * The template hash: the schema inputs, the namespace, and the checkout. Every
 * worktree shares one IntegreSQL service, so each gets its own templates and
 * pools: another worktree's failed migration (which discards its template)
 * or pool exhaustion never reaches this one. The hash is read
 * from disk on each call, and a lease releases under the hash it was checked
 * out with, so a migration edited mid-run cannot turn a release into a 404.
 */
function templateHash(namespace: TemplateNamespace): string {
  return createHash("sha1")
    .update(hashSchemaTemplateInputs())
    .update("\0")
    .update(namespace)
    .update("\0")
    .update(worktreeRoot)
    .digest("hex");
}

function connectionUrl(config: {
  username: string;
  password: string;
  database: string;
}): string {
  const { host, port } = testServiceConfig();
  return integreSQL().databaseConfigToConnectionUrl({ ...config, host, port });
}

const preparedHashes = new Map<TemplateNamespace, string>();

/** IntegreSQL coordinates preparation; dead initializers recover without locks. */
export async function prepareTemplate(
  namespace: TemplateNamespace,
): Promise<void> {
  const hash = await initializeRecoverableTemplate(
    templateHash(namespace),
    async (config) => {
      console.log(`[test database] Preparing the ${namespace} template`);
      if (namespace !== "migration") await cloneSchemaTemplate(config.database);
      console.log(`[test database] Prepared the ${namespace} template`);
    },
  );
  preparedHashes.set(namespace, hash);
}

/**
 * Check out one fresh database cloned from the namespace's template.
 *
 * `setup` runs against the new lease before it is returned (seeding, sanity
 * checks, opening the holder's pool) and its result comes back as `prepared`.
 * If it throws, the lease is released before the error propagates, so a failed
 * checkout never leaves a dirty database in the pool. A setup that opens a
 * resource of its own closes it before throwing.
 */
export async function leaseDatabase<T>(
  namespace: TemplateNamespace,
  setup: (lease: DatabaseLease) => Promise<T>,
): Promise<{ lease: DatabaseLease; prepared: T }> {
  if (!preparedHashes.has(namespace)) await prepareTemplate(namespace);
  const hash = preparedHashes.get(namespace);
  if (!hash) throw new Error(`Missing prepared ${namespace} template`);
  const { id, database } = await integreSQL().api.getTestDatabase(hash);
  const name = database.config.database;
  let released: Promise<void> | undefined;
  const lease: DatabaseLease = {
    name,
    databaseUrl: connectionUrl(database.config),
    close: () => (released ??= release(hash, id, name)),
  };
  try {
    return { lease, prepared: await setup(lease) };
  } catch (error) {
    try {
      await lease.close();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Setup of ${name} failed and releasing it also failed`,
        { cause: releaseError },
      );
    }
    throw error;
  }
}

/** Migration rehearsals start empty and apply their own committed journal boundary. */
export async function withMigrationDatabase<T>(
  run: (client: Client, databaseUrl: string) => Promise<T>,
): Promise<T> {
  const { lease, prepared: connection } = await leaseDatabase(
    "migration",
    async ({ databaseUrl }) => {
      const connection = new Client({ connectionString: databaseUrl });
      try {
        await connection.connect();
        return connection;
      } catch (error) {
        await connection.end();
        throw error;
      }
    },
  );
  try {
    return await run(connection, lease.databaseUrl);
  } finally {
    try {
      await connection.end();
    } finally {
      await lease.close();
    }
  }
}

/**
 * `recreate`, not `reuse`: the holder has dirtied the database. A failed
 * release is loud because IntegreSQL serves a fixed ring of databases and,
 * told nothing, re-hands one that is still in use or dirty; that surfaces later
 * as `duplicate key ... "user_pkey"` in some unrelated test.
 */
async function release(hash: string, id: number, name: string) {
  try {
    await integreSQL().api.recreateTestDatabase(hash, id);
  } catch (error) {
    throw new Error(
      `Failed to release IntegreSQL database ${name}; it may be re-handed to another test while still dirty. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * What acquisition callbacks may see. They get no close handle: a callback that
 * closed a retain-mode lease and then threw would memoize the non-dropping
 * close and bypass the forced DROP of a failed acquisition.
 */
type NamedDatabaseTarget = Pick<DatabaseLease, "name" | "databaseUrl">;

/**
 * Native fixtures own individually named databases on the guarded local server.
 * Retention applies only after successful setup; a failed acquisition drops the
 * database it created. A CREATE collision never makes the caller its owner.
 *
 * `onCreated` runs immediately after CREATE establishes ownership and before
 * migration, so a runner's out-of-process watchdog covers the database even if
 * the runner is killed mid-migration (regression: #1628 review). Scenario
 * seed/reset policies stay in `setup`, which runs after migration.
 */
export async function leaseNamedDatabase<T>(
  options: {
    adminUrl: string;
    name: string;
    retention: "drop" | "retain";
    onCreated?: (target: NamedDatabaseTarget) => void | Promise<void>;
  },
  setup: (target: NamedDatabaseTarget) => Promise<T>,
): Promise<{ lease: DatabaseLease; prepared: T }> {
  const adminUrl = assertSimulatorAdminUrl(options.adminUrl);
  assertSimulatorDatabaseName(options.name);
  const target = new URL(adminUrl);
  target.pathname = `/${options.name}`;
  const databaseUrl = target.toString();
  const admin = createPostgresPool({ connectionString: adminUrl.toString() });
  let created = false;
  let closed: Promise<void> | undefined;
  const close = async (drop: boolean) => {
    const errors: unknown[] = [];
    try {
      if (created && drop) {
        await admin.query(`DROP DATABASE "${options.name}" WITH (FORCE)`);
        const remaining = await admin.query(
          "SELECT 1 FROM pg_database WHERE datname = $1",
          [options.name],
        );
        if (remaining.rowCount !== 0)
          throw new Error(`Cleanup failed for ${options.name}`);
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `Named database cleanup failed for ${options.name}`,
      );
  };
  const lease: DatabaseLease = {
    name: options.name,
    databaseUrl,
    close: () => (closed ??= close(options.retention === "drop")),
  };
  try {
    await admin.query(`CREATE DATABASE "${options.name}"`);
    created = true;
    const visible = { name: options.name, databaseUrl };
    await options.onCreated?.(visible);
    // One Client, not a Pool: Client.end() resolves only once the socket has
    // closed, while Pool.end() can return with a backend still connected, which
    // a later DROP ... WITH (FORCE) then terminates as an unhandled 57P01.
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await migrateDatabase(drizzle(client));
    } finally {
      await client.end();
    }
    return { lease, prepared: await setup(visible) };
  } catch (error) {
    try {
      await (closed ??= close(true));
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Acquisition of ${options.name} failed and its cleanup failed`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

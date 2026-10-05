import { createHash } from "node:crypto";
import { IntegreSQLClient } from "@devoxa/integresql-client";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrateDatabase } from "./db-migrate";
import { hashSchemaTemplateInputs } from "./schema-template-inputs";
import {
  assertSimulatorAdminUrl,
  assertSimulatorDatabaseName,
} from "./sim-db-guard";
import { testServiceConfig } from "./test-service-config";

/**
 * Disposable databases for Vitest, browser E2E and native runners.
 * IntegreSQL serves the Vitest integration tier and browser E2E workers;
 * guarded named databases serve native fixtures. The adapters (`tooling/test-setup.ts`,
 * `tests/e2e/e2e-database.ts`) keep their own seeding and reset policies;
 * this module owns template preparation, checkout, and release.
 *
 * Browser acceptance and Vitest can share one IntegreSQL service (a warm local
 * service, or two terminals). Each namespace gets its own template, so one
 * process's template initialization cannot invalidate a database the other
 * has checked out.
 */
type TemplateNamespace = "vitest" | "browser";

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
 * The template hash: the schema inputs plus the namespace. The hash is read
 * from disk on each call, and a lease releases under the hash it was checked
 * out with, so a migration edited mid-run cannot turn a release into a 404.
 */
function templateHash(namespace: TemplateNamespace): string {
  return createHash("sha1")
    .update(hashSchemaTemplateInputs())
    .update("\0")
    .update(namespace)
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

/**
 * Create and migrate the namespace's template unless IntegreSQL already holds
 * one for the current schema. A run's global setup calls it before any
 * {@link leaseDatabase}; a failed migration discards the template. When another
 * process is already initializing the same template this returns at once, and
 * IntegreSQL holds each checkout until that template is finalized.
 */
export async function prepareTemplate(
  namespace: TemplateNamespace,
): Promise<void> {
  // The client discards the template after a failed migration and rethrows,
  // but a failed discard replaces the migration error; keep both.
  let migrationError: unknown;
  try {
    await integreSQL().initializeTemplate(
      templateHash(namespace),
      async (config) => {
        console.log(`[test database] Migrating the ${namespace} template`);
        const pool = new Pool({ connectionString: connectionUrl(config) });
        try {
          await migrateDatabase(drizzle(pool));
        } catch (error) {
          migrationError = error;
          console.error(
            `[test database] Migrating the ${namespace} template failed`,
            error,
          );
          throw error;
        } finally {
          await pool.end();
        }
        console.log(`[test database] Migrated the ${namespace} template`);
      },
    );
  } catch (error) {
    if (migrationError !== undefined && error !== migrationError) {
      throw new AggregateError(
        [migrationError, error],
        `Migrating the ${namespace} template failed, then discarding it failed`,
        { cause: error },
      );
    }
    throw error;
  }
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
  const hash = templateHash(namespace);
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
 * Native fixtures own individually named databases on the guarded local server.
 * Retention applies only after successful setup; a failed acquisition drops the
 * database it created. A CREATE collision never makes the caller its owner.
 * Watchdogs and scenario seed/reset policies stay with their native runner.
 */
export async function leaseNamedDatabase<T>(
  options: { adminUrl: string; name: string; retention: "drop" | "retain" },
  setup: (lease: DatabaseLease) => Promise<T>,
): Promise<{ lease: DatabaseLease; prepared: T }> {
  const adminUrl = assertSimulatorAdminUrl(options.adminUrl);
  assertSimulatorDatabaseName(options.name);
  const target = new URL(adminUrl);
  target.pathname = `/${options.name}`;
  const databaseUrl = target.toString();
  const admin = new Pool({ connectionString: adminUrl.toString() });
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
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await migrateDatabase(drizzle(pool));
    } finally {
      await pool.end();
    }
    return { lease, prepared: await setup(lease) };
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

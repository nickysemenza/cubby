import { pollUntil } from "@cubby/shared/retry";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createE2EDatabase } from "../tests/e2e/e2e-database";
import { leaseDatabase, prepareTemplate } from "./test-database-lease";
import { TEST_USER_ID, withTestDb } from "./test-setup";

// Failure modes this file pins at the real IntegreSQL/PostgreSQL boundary:
// a released database returns to the pool still dirty (reuse instead of
// recreate, or no release at all); a second close re-releases a slot another
// lease may already hold; preparing one namespace's template invalidates a
// database the other namespace has checked out; a checkout whose setup fails
// (seeding, opening the holder's pool) leaks a dirty database.

const maintenance = new Map<string, Pool>();
afterAll(async () => {
  await Promise.all([...maintenance.values()].map((pool) => pool.end()));
});

/** A pool on the server's `postgres` database, which IntegreSQL never drops. */
function maintenancePool(databaseUrl: string): Pool {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  const key = url.toString();
  let pool = maintenance.get(key);
  if (!pool) {
    pool = new Pool({ connectionString: key, max: 1 });
    maintenance.set(key, pool);
  }
  return pool;
}

async function databaseOid(databaseUrl: string, name: string) {
  const { rows } = await maintenancePool(databaseUrl).query<{ oid: string }>(
    "SELECT oid::text FROM pg_database WHERE datname = $1",
    [name],
  );
  return rows[0]?.oid;
}

async function writeProbe(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query("CREATE TABLE lease_probe (id integer)");
  } finally {
    await pool.end();
  }
}

async function hasProbe(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ probe: string | null }>(
      "SELECT to_regclass('public.lease_probe')::text AS probe",
    );
    return rows[0]?.probe !== null;
  } finally {
    await pool.end();
  }
}

/**
 * Wait until IntegreSQL has dropped and recreated `name` from its template
 * (a new `pg_database` oid), then report whether the earlier write survived.
 * A release that returns the database dirty never changes the oid, so this
 * times out instead of passing.
 */
async function recreatedProbeSurvives(
  databaseUrl: string,
  name: string,
  oidBefore: string,
) {
  await pollUntil(
    async () => {
      const oid = await databaseOid(databaseUrl, name);
      return oid !== undefined && oid !== oidBefore ? oid : undefined;
    },
    // Recreation is asynchronous and queues behind every other release in a
    // busy CI shard, so it can take far longer than one checkout.
    { label: `IntegreSQL recreating ${name}`, timeoutMs: 45_000 },
  );
  return hasProbe(databaseUrl);
}

describe("disposable database lease", { timeout: 60_000 }, () => {
  const ctx = withTestDb();

  it("recreates a released database from the template, once", async () => {
    await prepareTemplate("browser");
    const lease = await createE2EDatabase();
    await writeProbe(lease.databaseUrl);
    const oid = await databaseOid(lease.databaseUrl, lease.name);
    expect(oid).toBeDefined();

    await lease.close();
    await lease.close();

    expect(
      await recreatedProbeSurvives(lease.databaseUrl, lease.name, oid ?? ""),
    ).toBe(false);
  });

  it("releases a checkout whose setup fails", async () => {
    await prepareTemplate("browser");
    let leased: { name: string; databaseUrl: string; oid?: string } | undefined;
    await expect(
      leaseDatabase("browser", async ({ name, databaseUrl }) => {
        await writeProbe(databaseUrl);
        leased = {
          name,
          databaseUrl,
          oid: await databaseOid(databaseUrl, name),
        };
        throw new Error("synthetic seed failure");
      }),
    ).rejects.toThrow("synthetic seed failure");

    expect(leased?.oid).toBeDefined();
    expect(
      await recreatedProbeSurvives(
        leased?.databaseUrl ?? "",
        leased?.name ?? "",
        leased?.oid ?? "",
      ),
    ).toBe(false);
  });

  it("keeps the Vitest and browser templates apart while both are leased", async () => {
    const vitest = new Pool({ connectionString: ctx.databaseUrl, max: 1 });
    try {
      const [browser, current] = await Promise.all([
        prepareTemplate("browser").then(() => createE2EDatabase()),
        vitest.query<{ name: string }>("SELECT current_database() AS name"),
      ]);
      try {
        const vitestName = current.rows[0]?.name ?? "";
        const templateOf = (name: string) =>
          /^integresql_test_(.+)_\d+$/u.exec(name)?.[1];
        expect(templateOf(vitestName)).toBeDefined();
        expect(templateOf(browser.name)).toBeDefined();
        expect(templateOf(browser.name)).not.toBe(templateOf(vitestName));

        // The Vitest database is still the seeded one this test started with.
        const users = await vitest.query(
          'SELECT id FROM "user" WHERE id = $1',
          [TEST_USER_ID],
        );
        expect(users.rows).toHaveLength(1);
      } finally {
        await browser.close();
      }
    } finally {
      await vitest.end();
    }
  });
});

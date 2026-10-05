import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { leaseNamedDatabase } from "./test-database-lease";

// Native cleanup must reject non-disposable targets, retain explicitly kept
// writes, release a failed setup even in retain mode, and never drop an existing
// database when acquisition collides with its name.
const adminUrl = "postgresql://postgres:password@localhost:55432/postgres";
const name = () => `cubby_sim_${randomBytes(8).toString("hex")}`;
async function exists(databaseName: string) {
  const admin = new Pool({ connectionString: adminUrl });
  try {
    const result = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    return result.rowCount === 1;
  } finally {
    await admin.end();
  }
}

it("drops a named database on close, once", async () => {
  const { lease } = await leaseNamedDatabase(
    { adminUrl, name: name(), retention: "drop" },
    async () => undefined,
  );
  expect(await exists(lease.name)).toBe(true);
  await lease.close();
  await lease.close();
  expect(await exists(lease.name)).toBe(false);
}, 120_000);

it("retains writes and preserves the holder's database on a colliding acquisition", async () => {
  const databaseName = name();
  const { lease } = await leaseNamedDatabase(
    { adminUrl, name: databaseName, retention: "retain" },
    async ({ databaseUrl }) => {
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        await pool.query("CREATE TABLE named_lease_probe (id integer)");
      } finally {
        await pool.end();
      }
    },
  );
  try {
    await lease.close();
    await expect(
      leaseNamedDatabase(
        { adminUrl, name: databaseName, retention: "drop" },
        async () => undefined,
      ),
    ).rejects.toThrow(/already exists/u);
    const pool = new Pool({ connectionString: lease.databaseUrl });
    try {
      expect(
        (await pool.query("SELECT to_regclass('named_lease_probe') AS probe"))
          .rows[0]?.probe,
      ).toBe("named_lease_probe");
    } finally {
      await pool.end();
    }
  } finally {
    const admin = new Pool({ connectionString: adminUrl });
    try {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}, 120_000);

it("drops a named database whose setup fails even when retention was requested", async () => {
  const databaseName = name();
  await expect(
    leaseNamedDatabase(
      { adminUrl, name: databaseName, retention: "retain" },
      async () => {
        throw new Error("synthetic native seed failure");
      },
    ),
  ).rejects.toThrow("synthetic native seed failure");
  expect(await exists(databaseName)).toBe(false);
}, 120_000);

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { beforeAll, expect, it } from "vitest";
import { leaseNamedDatabase } from "./test-database-lease";

// Native cleanup must reject non-disposable targets, retain explicitly kept
// writes, release a failed setup even in retain mode, and never drop an existing
// database when acquisition collides with its name. A runner killed while
// the lease migrates must already have handed the database to its watchdog.
const adminUrl = "postgresql://postgres:password@localhost:55432/postgres";

// The guard admits only this endpoint. CI publishes it from
// .github/actions/start-test-services; locally it is the dev database service,
// which this suite starts the same way the native runners do before leasing.
beforeAll(() => {
  if (process.env.CI || process.env.CUBBY_SIM_DB_EXTERNAL === "1") return;
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  // `env -i`: the test environment's DATABASE_URL and service overrides
  // would fail the dev profile's override checks; the container CLI needs
  // only PATH and HOME.
  const started = spawnSync(
    "/usr/bin/env",
    [
      "-i",
      `PATH=${process.env.PATH ?? ""}`,
      `HOME=${process.env.HOME ?? ""}`,
      process.execPath,
      path.join(repoRoot, "scripts/dev-db.ts"),
      "up",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (started.status !== 0)
    throw new Error(
      "Could not start the guarded native PostgreSQL on localhost:55432 (node scripts/dev-db.ts up)",
    );
}, 240_000);
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
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query("CREATE TABLE named_lease_probe (id integer)");
      } finally {
        await client.end();
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
    // Clients, not Pools, before a forced DROP: see leaseNamedDatabase.
    const client = new Client({ connectionString: lease.databaseUrl });
    await client.connect();
    try {
      expect(
        (await client.query("SELECT to_regclass('named_lease_probe') AS probe"))
          .rows[0]?.probe,
      ).toBe("named_lease_probe");
    } finally {
      await client.end();
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

it("hands the database to its watchdog before migration, so a runner killed mid-migration leaves nothing", async () => {
  const databaseName = name();
  const toolingDir = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = path.resolve(toolingDir, "..");
  const log = path.join(
    mkdtempSync(path.join(tmpdir(), "named-lease-")),
    "watchdog.log",
  );
  // The child plays a native runner whose acquisition hook starts the real
  // watchdog. Plain node + the tsx loader keeps the killed pid the one the
  // watchdog watches. The hook waits for "go" only so this test can block the
  // migration on a lock before it starts.
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      const { spawn } = await import("node:child_process");
      const { leaseNamedDatabase } = await import(${JSON.stringify(path.join(toolingDir, "test-database-lease.ts"))});
      await leaseNamedDatabase(
        {
          adminUrl: ${JSON.stringify(adminUrl)},
          name: ${JSON.stringify(databaseName)},
          retention: "retain",
          onCreated: async () => {
            spawn(
              process.execPath,
              [${JSON.stringify(path.join(toolingDir, "e2e-db-watchdog.mjs"))}, ${JSON.stringify(adminUrl)}, ${JSON.stringify(databaseName)}, String(process.pid), ${JSON.stringify(log)}],
              { detached: true, stdio: "ignore" },
            ).unref();
            process.stdout.write("created\\n");
            await new Promise((resolve) => process.stdin.once("data", resolve));
          },
        },
        async () => process.stdout.write("setup reached\\n"),
      );
      `,
    ],
    { cwd: webRoot, stdio: ["pipe", "pipe", "inherit"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
  const exited = new Promise((resolve) =>
    child.on("exit", (_code, signal) => resolve(signal)),
  );
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const holder = new Pool({ connectionString: target.toString() });
  const admin = new Pool({ connectionString: adminUrl });
  try {
    await expect
      .poll(() => stdout, { timeout: 60_000, interval: 50 })
      .toContain("created");
    // An uncommitted drizzle schema makes the migrator's CREATE SCHEMA wait.
    const lock = await holder.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("CREATE SCHEMA drizzle");
      child.stdin.write("go\n");
      await expect
        .poll(
          async () =>
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
                [databaseName],
              )
            ).rowCount,
          { timeout: 60_000, interval: 100 },
        )
        .toBe(1);
      child.kill("SIGKILL");
      expect(await exited).toBe("SIGKILL");
      await lock.query("ROLLBACK");
    } finally {
      // The watchdog may force-drop next; never return this socket to idle.
      lock.release(true);
    }
    expect(stdout).not.toContain("setup reached");
    await expect
      .poll(() => exists(databaseName), { timeout: 30_000, interval: 500 })
      .toBe(false);
    await holder.end();
    expect(readFileSync(log, "utf8")).toContain(`Dropped ${databaseName}`);
  } finally {
    child.kill("SIGKILL");
    await holder.end().catch(() => undefined);
    try {
      await admin.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
    } finally {
      await admin.end();
    }
  }
}, 120_000);

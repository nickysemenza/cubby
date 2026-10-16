import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { prepareDevDatabase, pruneCheckoutDatabases } from "./corpus-template";
import { testServiceConfig } from "../test-service-config";
import { resolveDevProfile } from "../../../../scripts/lib/dev-profile";
import { databaseIdentifier } from "../schema-template";

// Failure modes: clone loses auth/audit/search/image rows; startup overwrites
// edits; collection drops an active checkout or an unlabelled local database.
it("clones the application corpus, retains checkout edits, and collects only abandoned labelled checkouts", async () => {
  const config = testServiceConfig();
  const host = config.host;
  const port = ["localhost", "127.0.0.1"].includes(host) ? 55432 : config.port;
  const checkout = realpathSync(
    mkdtempSync(join(tmpdir(), "cubby-template-contract-")),
  );
  const name = resolveDevProfile(checkout, {}).name;
  const url = `postgresql://postgres:password@${host}:${port}/${name}`;
  const admin = new Client({
    connectionString: `postgresql://postgres:password@${host}:${port}/postgres`,
  });
  await admin.connect();
  try {
    await prepareDevDatabase(name, checkout, url);
    const db = new Client({ connectionString: url });
    await db.connect();
    try {
      const counts = await db.query(
        `SELECT (SELECT count(*)::int FROM "AuditLog") AS audit, (SELECT count(*)::int FROM "SearchDocument") AS search, (SELECT count(*)::int FROM "Image" WHERE "storageStatus" = 'available') AS images, (SELECT count(*)::int FROM account WHERE provider_id = 'credential' AND password IS NOT NULL) AS credentials`,
      );
      expect(counts.rows[0].audit).toBeGreaterThan(200);
      expect(counts.rows[0].search).toBeGreaterThan(100);
      expect(counts.rows[0].images).toBe(3);
      expect(counts.rows[0].credentials).toBe(1);
      const pending = await db.query<{ body: unknown }>(
        "SELECT body FROM cubby_dev_background_task",
      );
      expect(pending.rows.length).toBeGreaterThan(0);
      for (const row of pending.rows)
        expect(backgroundTaskMessageSchema.safeParse(row.body).success).toBe(
          true,
        );
      await db.query(
        `UPDATE cubby_dev_fixture SET state = 'retained' WHERE pack = 'core'`,
      );
      await prepareDevDatabase(name, checkout, url);
      expect(
        (
          await db.query(
            "SELECT state FROM cubby_dev_fixture WHERE pack = 'core'",
          )
        ).rows[0].state,
      ).toBe("retained");
      await pruneCheckoutDatabases(admin, "cubby_dev_requested");
      expect(
        (
          await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
            name,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      await db.end();
    }
    rmSync(checkout, { recursive: true, force: true });
    await pruneCheckoutDatabases(admin, "cubby_dev_requested");
    expect(
      (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
        .rowCount,
    ).toBe(0);
  } finally {
    await admin.query(
      `DROP DATABASE IF EXISTS ${databaseIdentifier(name)} WITH (FORCE)`,
    );
    await admin.end();
    rmSync(checkout, { recursive: true, force: true });
  }
}, 120_000);

// Collection must preserve explicit/instance names, connected databases and the
// requested target even when their original checkout has disappeared.
it("collects only idle derived checkout names and refreshes reused ownership", async () => {
  const config = testServiceConfig();
  const port = ["localhost", "127.0.0.1"].includes(config.host)
    ? 55432
    : config.port;
  const base = `postgresql://postgres:password@${config.host}:${port}`;
  const admin = new Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  const checkout = realpathSync(
    mkdtempSync(join(tmpdir(), "cubby-collection-")),
  );
  const nextCheckout = realpathSync(
    mkdtempSync(join(tmpdir(), "cubby-collection-next-")),
  );
  const derived = resolveDevProfile(checkout, {}).name;
  const explicit = `cubby_dev_review_${randomUUID().replaceAll("-", "")}`;
  const instance = resolveDevProfile(checkout, {
    CUBBY_DEV_INSTANCE: "review",
  }).name;
  const connected = new Client({ connectionString: `${base}/${derived}` });
  try {
    for (const name of [derived, explicit, instance]) {
      await admin.query(`CREATE DATABASE ${databaseIdentifier(name)}`);
      await admin.query(
        `COMMENT ON DATABASE ${databaseIdentifier(name)} IS '${checkout}'`,
      );
    }
    await connected.connect();
    rmSync(checkout, { recursive: true, force: true });
    await pruneCheckoutDatabases(admin, "cubby_dev_requested");
    expect(
      (await connected.query("SELECT 1 AS retained")).rows[0].retained,
    ).toBe(1);
    for (const name of [derived, explicit, instance])
      expect(
        (
          await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
            name,
          ])
        ).rowCount,
      ).toBe(1);
    await connected.end();
    await pruneCheckoutDatabases(admin, derived);
    expect(
      (
        await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
          derived,
        ])
      ).rowCount,
    ).toBe(1);
    await pruneCheckoutDatabases(admin, "cubby_dev_requested");
    expect(
      (
        await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
          derived,
        ])
      ).rowCount,
    ).toBe(0);
    await prepareDevDatabase(explicit, nextCheckout, `${base}/${explicit}`);
    expect(
      (
        await admin.query(
          "SELECT shobj_description(oid, 'pg_database') AS checkout FROM pg_database WHERE datname=$1",
          [explicit],
        )
      ).rows[0].checkout,
    ).toBe(nextCheckout);
  } finally {
    await connected.end();
    for (const name of [derived, explicit, instance])
      await admin.query(
        `DROP DATABASE IF EXISTS ${databaseIdentifier(name)} WITH (FORCE)`,
      );
    await admin.end();
    rmSync(checkout, { recursive: true, force: true });
    rmSync(nextCheckout, { recursive: true, force: true });
  }
});

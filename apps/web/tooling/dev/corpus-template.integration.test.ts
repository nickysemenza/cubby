import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { prepareDevDatabase, pruneCheckoutDatabases } from "./corpus-template";
import { testServiceConfig } from "../test-service-config";
import { resolveDevProfile } from "../dev-services/dev-profile";
import { databaseIdentifier } from "../schema-template";

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
    rmSync(checkout, { recursive: true, force: true, maxRetries: 5 });
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
    rmSync(checkout, { recursive: true, force: true, maxRetries: 5 });
    rmSync(nextCheckout, { recursive: true, force: true, maxRetries: 5 });
  }
});

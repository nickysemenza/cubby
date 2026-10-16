import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { prepareDevDatabase, pruneCheckoutDatabases } from "./corpus-template";
import { testServiceConfig } from "../test-service-config";
import { databaseIdentifier } from "../schema-template";

// Failure modes: clone loses auth/audit/search/image rows; startup overwrites
// edits; collection drops an active checkout or an unlabelled local database.
it("clones the application corpus, retains checkout edits, and collects only abandoned labelled checkouts", async () => {
  const { host, port } = testServiceConfig();
  const name = `cubby_dev_contract_${randomUUID().replaceAll("-", "")}`;
  const checkout = mkdtempSync(join(tmpdir(), "cubby-template-contract-"));
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
      await pruneCheckoutDatabases(admin);
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
    await pruneCheckoutDatabases(admin);
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { withTransaction } from "./database-helpers";

const migration = (phase: "expand" | "enable") =>
  readFileSync(
    resolve(
      process.cwd(),
      `../../scripts/cutovers/inventory-ownership-image-processing.${phase}.sql`,
    ),
    "utf8",
  ).replace(/^BEGIN;|^COMMIT;/gm, "");

const ctx = withTestDb();

it("expands legacy inventory without assigning owners and enables distinct owner slots", async () => {
  // A separate schema exercises the checked-in SQL cutover against its pre-change
  // contract, rather than merely pushing the final Drizzle schema.
  await withTransaction(ctx.db, async (tx) => {
    await tx.execute(
      sql.raw(`
      CREATE SCHEMA migration_contract;
      SET LOCAL search_path TO migration_contract;
      CREATE TABLE "LedgerParty" (id uuid PRIMARY KEY);
      CREATE TABLE "InventoryEntry" (
        id uuid PRIMARY KEY, "productId" uuid NOT NULL, "locationId" uuid NOT NULL,
        placement text NOT NULL DEFAULT '', "deletedAt" timestamp
      );
      CREATE UNIQUE INDEX "InventoryEntry_productId_locationId_key"
        ON "InventoryEntry" ("productId", "locationId", placement) WHERE "deletedAt" IS NULL;
      CREATE TABLE "VendorAccount" (id uuid PRIMARY KEY);
      CREATE TABLE "FinancialAccount" (id uuid PRIMARY KEY);
      CREATE TABLE "Image" (id uuid PRIMARY KEY);
      CREATE TABLE "AiAnalysis" (
        id uuid PRIMARY KEY, "entityType" text, "entityId" uuid, feature text, model text,
        "promptVersion" text, "inputFingerprint" text, "deletedAt" timestamp
      );
      CREATE UNIQUE INDEX "AiAnalysis_active_key" ON "AiAnalysis"
        ("entityType", "entityId", feature, model, "promptVersion", "inputFingerprint") WHERE "deletedAt" IS NULL;
      INSERT INTO "InventoryEntry" (id, "productId", "locationId") VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003');
    `),
    );
    await tx.execute(sql.raw(migration("expand")));
    await tx.execute(sql.raw(migration("enable")));
    await tx.execute(
      sql`INSERT INTO "VendorAccount" (id) VALUES (${crypto.randomUUID()})`,
    );
    const defaults = await tx.execute(
      sql`SELECT "inventoryOwnerDefaultEnabled" FROM "VendorAccount"`,
    );
    expect(defaults.rows).toEqual([{ inventoryOwnerDefaultEnabled: false }]);
    await expect(
      tx.transaction(async (duplicate) => {
        await duplicate.execute(sql`INSERT INTO "InventoryEntry" (id, "productId", "locationId")
        SELECT ${crypto.randomUUID()}::uuid, "productId", "locationId" FROM "InventoryEntry" LIMIT 1`);
      }),
    ).rejects.toThrow(/duplicate key|check constraint|Failed query/);
    await expect(
      tx.transaction(async (invalid) => {
        await invalid.execute(
          sql`UPDATE "InventoryEntry" SET "ownershipMode" = 'person'`,
        );
      }),
    ).rejects.toThrow(/duplicate key|check constraint|Failed query/);
    const original = await tx.execute(
      sql`SELECT "ownershipMode", "ownerLedgerPartyId" FROM "InventoryEntry"`,
    );
    expect(original.rows).toEqual([
      { ownershipMode: "inherit", ownerLedgerPartyId: null },
    ]);
    await tx.execute(
      sql.raw(`
      INSERT INTO "LedgerParty" (id) VALUES ('00000000-0000-4000-8000-000000000004');
      INSERT INTO "InventoryEntry" (id, "productId", "locationId", "ownershipMode", "ownerLedgerPartyId") VALUES
        ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'person', '00000000-0000-4000-8000-000000000004');
    `),
    );
    const slots = await tx.execute(
      sql`SELECT count(*)::int AS count FROM "InventoryEntry"`,
    );
    expect(slots.rows).toEqual([{ count: 2 }]);
  });
});

import { withMigrationDatabase } from "./test-database-lease";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";

// Dropping the retired label must preserve account identities, scope, status,
// cursor, ownership defaults, and linked Purchases, Runs and source claims.
it("retires VendorAccount labels without losing accounts or their references", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const contract = tags.findIndex((tag) =>
      tag.endsWith("_drop_vendor_account_label"),
    );
    if (contract < 1)
      throw new Error("VendorAccount label migration has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[contract - 1]! });

    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-vendor-member', 'Synthetic member', 'vendor-label@example.invalid')`,
    );
    await client.query(
      `INSERT INTO "LedgerParty" (shortcode, name, kind, "userId") VALUES ('LPY-4K7M', 'Morgan', 'member', 'synthetic-vendor-member')`,
    );
    await client.query(
      `INSERT INTO "Vendor" (shortcode, name) VALUES ('VEN-4K7M', 'Example Store'), ('VEN-7M4K', 'Sample Market')`,
    );
    await client.query(`INSERT INTO "VendorAccount" (shortcode, label, "vendorId", "ledgerPartyId", status, "inventoryOwnerDefaultEnabled", cursor)
      SELECT 'VACCT-4K7M', 'Synthetic custom login', v.id, p.id, 'disabled', true,
        '{"newestOrderAt":"2026-01-02T00:00:00.000Z","orderIdsOnNewestDate":["SYN-1"],"backfillBeforeOrderAt":null,"earliestAvailableOrderAt":null}'::jsonb
      FROM "Vendor" v, "LedgerParty" p WHERE v.shortcode = 'VEN-4K7M'`);
    await client.query(`INSERT INTO "Purchase" (shortcode, "vendorId", "vendorAccountId", "displayLabel")
      SELECT 'PUR-4K7M', a."vendorId", a.id, 'Synthetic order' FROM "VendorAccount" a`);
    await client.query(`INSERT INTO "Run" (shortcode, trigger, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "vendorAccountId", "ledgerPartyId", "vendorId")
      SELECT 'RUN-4K7M', 'manual', 'synthetic-vendor-member', 'Synthetic member', 'vendor-label@example.invalid', 'LPY-4K7M', a.id, a."ledgerPartyId", a."vendorId" FROM "VendorAccount" a`);
    await client.query(`INSERT INTO "ImportSourceClaim" (kind, "externalKey", checksum, "firstRunId", "lastRunId", "ledgerPartyId", "vendorAccountId")
      SELECT 'browser_order', 'synthetic-order-1', 'synthetic-checksum', r.id, r.id, r."ledgerPartyId", r."vendorAccountId" FROM "Run" r`);

    const accounts = async () =>
      (
        await client.query(
          `SELECT to_jsonb(a) - 'label' AS data FROM "VendorAccount" a ORDER BY shortcode`,
        )
      ).rows;
    const references = async () =>
      (
        await client.query(`SELECT
          (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM "Purchase" p) AS purchases,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM "Run" r) AS runs,
          (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM "ImportSourceClaim" c) AS claims,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM "Entity" e WHERE e.kind = 'vendorAccount') AS identities`)
      ).rows;

    // Preserve both a soft-deleted account and its live replacement.
    await client.query(`INSERT INTO "VendorAccount" (shortcode, label, "vendorId", "ledgerPartyId")
      SELECT 'VACCT-7M4K', 'Old writer label', v.id, p.id FROM "Vendor" v, "LedgerParty" p WHERE v.shortcode = 'VEN-7M4K'`);
    await client.query(
      `UPDATE "VendorAccount" SET "deletedAt" = now() WHERE shortcode = 'VACCT-7M4K'`,
    );
    await client.query(`INSERT INTO "VendorAccount" (shortcode, label, "vendorId", "ledgerPartyId")
      SELECT 'VACCT-M4K7', 'Synthetic replacement label', v.id, p.id FROM "Vendor" v, "LedgerParty" p WHERE v.shortcode = 'VEN-7M4K'`);
    expect(
      (
        await client.query(
          `SELECT shortcode, label FROM "VendorAccount" ORDER BY shortcode`,
        )
      ).rows,
    ).toEqual([
      { shortcode: "VACCT-4K7M", label: "Synthetic custom login" },
      { shortcode: "VACCT-7M4K", label: "Old writer label" },
      { shortcode: "VACCT-M4K7", label: "Synthetic replacement label" },
    ]);

    const beforeAccounts = await accounts();
    const beforeReferences = await references();
    expect(beforeAccounts).toHaveLength(3);

    await migrateDatabase(drizzle(client), { through: tags[contract]! });

    expect(await accounts()).toEqual(beforeAccounts);
    expect(await references()).toEqual(beforeReferences);
    expect(beforeReferences[0]).toMatchObject({
      purchases: [expect.objectContaining({ shortcode: "PUR-4K7M" })],
      runs: [expect.objectContaining({ shortcode: "RUN-4K7M" })],
      claims: [expect.objectContaining({ externalKey: "synthetic-order-1" })],
    });
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'VendorAccount' AND column_name = 'label'`,
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
});

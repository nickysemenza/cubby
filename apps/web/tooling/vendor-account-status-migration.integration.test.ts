import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Removing a nonfunctional status must preserve both former populations,
// tombstones, cursors, ownership defaults and every account relationship.
it("retires VendorAccount status without changing relationships or import history", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const contract = tags.findIndex((tag) =>
      tag.endsWith("_drop_vendor_account_status"),
    );
    if (contract < 1)
      throw new Error("VendorAccount status migration has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[contract - 1]! });
    await client.query(`INSERT INTO "user" (id, name, email)
      VALUES ('synthetic-status-member', 'Synthetic member', 'status-member@example.invalid')`);
    await client.query(`INSERT INTO "LedgerParty" (shortcode, name, kind, "userId")
      VALUES ('LPY-4K7M', 'Synthetic member', 'member', 'synthetic-status-member')`);
    await client.query(`INSERT INTO "Vendor" (shortcode, name)
      VALUES ('VEN-4K7M', 'Example Store'), ('VEN-7M4K', 'Sample Market')`);
    await client.query(`INSERT INTO "VendorAccount" (shortcode, "vendorId", "ledgerPartyId", status, "inventoryOwnerDefaultEnabled", cursor)
      SELECT 'VACCT-4K7M', v.id, p.id, 'disabled', true,
        '{"newestOrderAt":"2026-01-02T00:00:00.000Z","orderIdsOnNewestDate":["SYN-1"],"backfillBeforeOrderAt":null,"earliestAvailableOrderAt":null}'::jsonb
      FROM "Vendor" v, "LedgerParty" p WHERE v.shortcode = 'VEN-4K7M'`);
    await client.query(`INSERT INTO "VendorAccount" (shortcode, "vendorId", "ledgerPartyId", status)
      SELECT 'VACCT-7M4K', v.id, p.id, 'active' FROM "Vendor" v, "LedgerParty" p WHERE v.shortcode = 'VEN-7M4K'`);
    await client.query(`INSERT INTO "VendorAccount" (shortcode, "vendorId", "ledgerPartyId", status, "deletedAt")
      SELECT 'VACCT-M4K7', v.id, p.id, 'disabled', now() FROM "Vendor" v, "LedgerParty" p WHERE v.shortcode = 'VEN-7M4K'`);
    await client.query(`INSERT INTO "Purchase" (shortcode, "vendorId", "vendorAccountId", "displayLabel")
      SELECT 'PUR-4K7M', a."vendorId", a.id, 'Synthetic order' FROM "VendorAccount" a WHERE a.shortcode = 'VACCT-4K7M'`);
    await client.query(`INSERT INTO "Run" (shortcode, trigger, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "vendorAccountId", "ledgerPartyId", "vendorId")
      SELECT 'RUN-4K7M', 'manual', 'synthetic-status-member', 'Synthetic member', 'status-member@example.invalid', 'LPY-4K7M', a.id, a."ledgerPartyId", a."vendorId" FROM "VendorAccount" a WHERE a.shortcode = 'VACCT-4K7M'`);
    await client.query(`INSERT INTO "ImportSourceClaim" (kind, "externalKey", checksum, "firstRunId", "lastRunId", "ledgerPartyId", "vendorAccountId")
      SELECT 'browser_order', 'synthetic-status-order', 'synthetic-status-checksum', r.id, r.id, r."ledgerPartyId", r."vendorAccountId" FROM "Run" r WHERE r.shortcode = 'RUN-4K7M'`);
    const accounts = async () =>
      (
        await client.query(
          `SELECT to_jsonb(a) - 'status' AS data FROM "VendorAccount" a ORDER BY shortcode`,
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
    const beforeAccounts = await accounts();
    const beforeReferences = await references();
    expect(beforeAccounts).toHaveLength(3);
    expect(
      (
        await client.query(
          `SELECT DISTINCT status FROM "VendorAccount" ORDER BY status`,
        )
      ).rows,
    ).toEqual([{ status: "active" }, { status: "disabled" }]);
    await migrateDatabase(drizzle(client), { through: tags[contract]! });
    expect(await accounts()).toEqual(beforeAccounts);
    expect(await references()).toEqual(beforeReferences);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'VendorAccount' AND column_name = 'status'`,
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
});

import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Expanding the live-status index must preserve predecessor Runs and keep
// their vendor-account ownership when a manual pause uses the plain status.
it("preserves existing Runs while counting manual pauses as active", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const index = tags.indexOf("0086_lying_nomad");
    if (index < 1) throw new Error("Paused Run migration has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[index - 1]! });
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-pause-member', 'Synthetic member', 'pause@example.test')`,
    );
    await client.query(
      `INSERT INTO "LedgerParty" (shortcode, name, kind, "userId") VALUES ('LPY-4K7M', 'Synthetic member', 'member', 'synthetic-pause-member')`,
    );
    await client.query(
      `INSERT INTO "Vendor" (shortcode, name) VALUES ('VEN-4K7M', 'Synthetic store')`,
    );
    await client.query(
      `INSERT INTO "VendorAccount" (shortcode, "vendorId", "ledgerPartyId") SELECT 'VACCT-4K7M', v.id, p.id FROM "Vendor" v, "LedgerParty" p`,
    );
    await client.query(
      `INSERT INTO "Run" (shortcode, trigger, status, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "vendorAccountId", "ledgerPartyId") SELECT 'RUN-4K7M', 'manual', 'paused_approval', 'synthetic-pause-member', 'Synthetic member', 'pause@example.test', 'LPY-4K7M', a.id, a."ledgerPartyId" FROM "VendorAccount" a`,
    );
    const rows = () =>
      client.query(
        `SELECT to_jsonb(r) AS data FROM "Run" r ORDER BY shortcode`,
      );
    const before = (await rows()).rows;
    await migrateDatabase(drizzle(client), { through: tags[index]! });
    expect((await rows()).rows).toEqual(before);
    await client.query(
      `UPDATE "Run" SET status = 'paused' WHERE shortcode = 'RUN-4K7M'`,
    );
    await expect(
      client.query(
        `INSERT INTO "Run" (shortcode, trigger, status, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "vendorAccountId", "ledgerPartyId") SELECT 'RUN-7M4K', 'manual', 'running', 'synthetic-pause-member', 'Synthetic member', 'pause@example.test', 'LPY-4K7M', a.id, a."ledgerPartyId" FROM "VendorAccount" a`,
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "Run_one_active_vendor_account_key",
    });
    expect((await rows()).rows).toHaveLength(1);
  });
});

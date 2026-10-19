import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Accepted source orders survive the migration unchanged; afterwards a deleted
// Purchase's detached row stays beside the order's re-import.
it("keeps accepted source orders and lets detached history sit beside a re-import", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const migration = tags.findIndex((tag) =>
      tag.endsWith("_import_source_order_history"),
    );
    if (migration < 1)
      throw new Error("Source order history migration is missing");
    await migrateDatabase(drizzle(client), { through: tags[migration - 1]! });
    await client.query(`INSERT INTO "user" (id, name, email)
      VALUES ('synthetic-history-member', 'Synthetic member', 'history-member@example.invalid')`);
    await client.query(`INSERT INTO "LedgerParty" (shortcode, name, kind, "userId")
      VALUES ('LPY-4K7M', 'Synthetic member', 'member', 'synthetic-history-member')`);
    await client.query(`INSERT INTO "Vendor" (shortcode, name)
      VALUES ('VEN-4K7M', 'Example Store')`);
    await client.query(`INSERT INTO "Purchase" (shortcode, "vendorId", "displayLabel")
      SELECT code, v.id, 'Synthetic order' FROM "Vendor" v, (VALUES ('PUR-4K7M'), ('PUR-7M4K')) AS codes(code)`);
    await client.query(`INSERT INTO "Run" (shortcode, trigger, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "ledgerPartyId")
      SELECT 'RUN-4K7M', 'manual', 'synthetic-history-member', 'Synthetic member', 'history-member@example.invalid', 'LPY-4K7M', p.id FROM "LedgerParty" p`);
    await client.query(`INSERT INTO "ImportSourceClaim" (kind, "externalKey", checksum, "firstRunId", "lastRunId", "ledgerPartyId")
      SELECT 'mail_message', 'gmail:synthetic-mailbox:synthetic-history', 'synthetic-history-checksum', r.id, r.id, r."ledgerPartyId" FROM "Run" r`);
    const upsert = (purchase: string, arbiter: string) =>
      client.query(`INSERT INTO "ImportSourceOrder" ("sourceClaimId", "orderKey", "purchaseId", checksum, "outputFingerprint")
        SELECT c.id, 'synthetic/order/1', p.id, 'synthetic-history-checksum', 'synthetic-fingerprint'
        FROM "ImportSourceClaim" c, "Purchase" p WHERE p.shortcode = '${purchase}'
        ON CONFLICT ("sourceClaimId", "orderKey") ${arbiter} DO UPDATE SET "outputFingerprint" = 'synthetic-replayed'`);
    const current = `WHERE "purchaseId" IS NOT NULL`;
    await upsert("PUR-4K7M", "");
    const rows = async () =>
      (
        await client.query(
          `SELECT to_jsonb(o) AS data FROM "ImportSourceOrder" o ORDER BY id`,
        )
      ).rows;
    const before = await rows();
    expect(before).toHaveLength(1);

    await migrateDatabase(drizzle(client), { through: tags[migration]! });
    expect(await rows()).toEqual(before);
    await upsert("PUR-4K7M", current);
    await client.query(
      `UPDATE "ImportSourceOrder" SET "purchaseId" = NULL, "updatedAt" = now()`,
    );
    await upsert("PUR-7M4K", current);
    expect(
      (
        await client.query(`SELECT p.shortcode, o."outputFingerprint"
          FROM "ImportSourceOrder" o LEFT JOIN "Purchase" p ON p.id = o."purchaseId"
          ORDER BY o."createdAt", o.id`)
      ).rows,
    ).toEqual([
      { shortcode: null, outputFingerprint: "synthetic-replayed" },
      { shortcode: "PUR-7M4K", outputFingerprint: "synthetic-fingerprint" },
    ]);
  });
});

import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Accepted source orders must survive unchanged, and the deployed writer's
// (sourceClaimId, orderKey) upsert must still find its unique arbiter while a
// deleted Purchase's history may now clear its link.
it("lets a source order outlive its Purchase without changing accepted rows or the writer's upsert", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const expand = tags.findIndex((tag) =>
      tag.endsWith("_import_source_order_history"),
    );
    if (expand < 1)
      throw new Error("Source order history migration has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[expand - 1]! });
    await client.query(`INSERT INTO "user" (id, name, email)
      VALUES ('synthetic-history-member', 'Synthetic member', 'history-member@example.invalid')`);
    await client.query(`INSERT INTO "LedgerParty" (shortcode, name, kind, "userId")
      VALUES ('LPY-4K7M', 'Synthetic member', 'member', 'synthetic-history-member')`);
    await client.query(`INSERT INTO "Vendor" (shortcode, name)
      VALUES ('VEN-4K7M', 'Example Store')`);
    await client.query(`INSERT INTO "Purchase" (shortcode, "vendorId", "displayLabel")
      SELECT 'PUR-4K7M', v.id, 'Synthetic order' FROM "Vendor" v`);
    await client.query(`INSERT INTO "Run" (shortcode, trigger, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "ledgerPartyId")
      SELECT 'RUN-4K7M', 'manual', 'synthetic-history-member', 'Synthetic member', 'history-member@example.invalid', 'LPY-4K7M', p.id FROM "LedgerParty" p`);
    await client.query(`INSERT INTO "ImportSourceClaim" (kind, "externalKey", checksum, "firstRunId", "lastRunId", "ledgerPartyId")
      SELECT 'mail_message', 'gmail:synthetic-mailbox:synthetic-history', 'synthetic-history-checksum', r.id, r.id, r."ledgerPartyId" FROM "Run" r`);
    const upsert = () =>
      client.query(`INSERT INTO "ImportSourceOrder" ("sourceClaimId", "orderKey", "purchaseId", checksum, "outputFingerprint")
        SELECT c.id, 'synthetic/order/1', p.id, 'synthetic-history-checksum', 'synthetic-fingerprint'
        FROM "ImportSourceClaim" c, "Purchase" p
        ON CONFLICT ("sourceClaimId", "orderKey") DO UPDATE SET "outputFingerprint" = 'synthetic-replayed'`);
    await upsert();
    const rows = async () =>
      (
        await client.query(
          `SELECT to_jsonb(o) AS data FROM "ImportSourceOrder" o ORDER BY id`,
        )
      ).rows;
    const before = await rows();
    expect(before).toHaveLength(1);
    await migrateDatabase(drizzle(client), { through: tags[expand]! });
    expect(await rows()).toEqual(before);

    await upsert();
    await client.query(
      `UPDATE "ImportSourceOrder" SET "purchaseId" = NULL, "updatedAt" = now()`,
    );
    expect(
      (
        await client.query(`SELECT p.shortcode, o."outputFingerprint"
          FROM "ImportSourceOrder" o LEFT JOIN "Purchase" p ON p.id = o."purchaseId"`)
      ).rows,
    ).toEqual([{ shortcode: null, outputFingerprint: "synthetic-replayed" }]);
  });
});

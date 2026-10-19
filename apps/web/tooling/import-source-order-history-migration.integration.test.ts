import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// The expansion keeps accepted rows unchanged and the deployed writer's
// (sourceClaimId, orderKey) upsert working. The later live-only key is a
// contraction: the old writer's predicate-less arbiter no longer matches, so
// it applies only after the server that names `WHERE "purchaseId" IS NOT
// NULL` deploys; then a deleted Purchase's row stays beside its re-import.
it("keeps accepted source orders through the expansion and lets detached history sit beside a re-import after the live-only key", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const expand = tags.findIndex((tag) =>
      tag.endsWith("_import_source_order_history"),
    );
    const contract = tags.findIndex((tag) =>
      tag.endsWith("_import_source_order_live_key"),
    );
    if (expand < 1 || contract <= expand)
      throw new Error("Source order history migrations are out of order");
    await migrateDatabase(drizzle(client), { through: tags[expand - 1]! });
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
    const deployed = "";
    const current = `WHERE "purchaseId" IS NOT NULL`;
    await upsert("PUR-4K7M", deployed);
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
    await upsert("PUR-4K7M", deployed);
    await upsert("PUR-4K7M", current);

    // The window before the contraction: the full key still conflicts with a
    // detached row, which the server's upsert takes over for the re-import.
    const linked = async () =>
      (
        await client.query(`SELECT p.shortcode FROM "ImportSourceOrder" o
          LEFT JOIN "Purchase" p ON p.id = o."purchaseId" ORDER BY o."createdAt", o.id`)
      ).rows;
    await client.query(`UPDATE "ImportSourceOrder" SET "purchaseId" = NULL`);
    await client.query(`INSERT INTO "ImportSourceOrder" ("sourceClaimId", "orderKey", "purchaseId", checksum, "outputFingerprint")
      SELECT c.id, 'synthetic/order/1', p.id, 'synthetic-history-checksum', 'synthetic-fingerprint'
      FROM "ImportSourceClaim" c, "Purchase" p WHERE p.shortcode = 'PUR-7M4K'
      ON CONFLICT ("sourceClaimId", "orderKey") ${current} DO UPDATE SET "purchaseId" = excluded."purchaseId"`);
    expect(await linked()).toEqual([{ shortcode: "PUR-7M4K" }]);
    await client.query(
      `UPDATE "ImportSourceOrder" SET "purchaseId" = p.id FROM "Purchase" p WHERE p.shortcode = 'PUR-4K7M'`,
    );

    await migrateDatabase(drizzle(client), { through: tags[contract]! });
    await expect(upsert("PUR-4K7M", deployed)).rejects.toThrow(
      /no unique or exclusion constraint matching the ON CONFLICT/,
    );
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

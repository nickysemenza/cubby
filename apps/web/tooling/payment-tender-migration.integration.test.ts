import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Adding payment tender is expand-only: retained payment evidence keeps every
// value and reads `unknown`, and existing entity links survive the widened kind
// CHECK unchanged.
it("adds payment tender and the payment-account link kind without changing retained rows", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const expand = tags.findIndex((tag) =>
      tag.endsWith("_payment_tender_and_payment_account_link"),
    );
    if (expand < 1)
      throw new Error("Payment tender migration has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[expand - 1]! });
    await client.query(`INSERT INTO "user" (id, name, email)
      VALUES ('synthetic-tender-member', 'Synthetic member', 'tender-member@example.invalid')`);
    await client.query(`INSERT INTO "LedgerParty" (shortcode, name, kind, "userId")
      VALUES ('LPY-4K7M', 'Synthetic member', 'member', 'synthetic-tender-member')`);
    await client.query(
      `INSERT INTO "Vendor" (shortcode, name) VALUES ('VEN-4K7M', 'Example Store')`,
    );
    await client.query(
      `INSERT INTO "Product" (shortcode, name, manufacturer) VALUES ('PRD-4K7M', 'Sample salt', 'Example Co')`,
    );
    await client.query(`INSERT INTO "Purchase" (shortcode, "vendorId", "displayLabel")
      SELECT 'PUR-4K7M', v.id, 'Synthetic order' FROM "Vendor" v WHERE v.shortcode = 'VEN-4K7M'`);
    await client.query(`INSERT INTO "Run" (shortcode, trigger, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "ledgerPartyId", "vendorId")
      SELECT 'RUN-4K7M', 'manual', 'synthetic-tender-member', 'Synthetic member', 'tender-member@example.invalid', 'LPY-4K7M', p.id, v.id
      FROM "LedgerParty" p, "Vendor" v WHERE p.shortcode = 'LPY-4K7M' AND v.shortcode = 'VEN-4K7M'`);
    await client.query(`INSERT INTO "ImportSourceClaim" (kind, "externalKey", checksum, "firstRunId", "lastRunId", "ledgerPartyId")
      SELECT 'browser_order', 'synthetic-tender-order', 'synthetic-tender-checksum', r.id, r.id, r."ledgerPartyId" FROM "Run" r WHERE r.shortcode = 'RUN-4K7M'`);
    await client.query(`INSERT INTO "PurchasePaymentEvidence" ("purchaseId", "sourceClaimId", amount, "chargedAt", "cardLastFour", description, "evidenceIndex")
      SELECT p.id, c.id, 13.59, '2026-01-02T00:00:00Z'::timestamp, NULL, 'Gift card', 0
      FROM "Purchase" p, "ImportSourceClaim" c WHERE p.shortcode = 'PUR-4K7M'
      UNION ALL
      SELECT p.id, c.id, 0, '2026-01-02T00:00:00Z'::timestamp, '1234', 'Card', 1
      FROM "Purchase" p, "ImportSourceClaim" c WHERE p.shortcode = 'PUR-4K7M'`);
    await client.query(`INSERT INTO "EntityLink" (kind, "fromKind", "fromEntityId", "toKind", "toEntityId")
      SELECT 'purchaseProduct', 'purchase', p.id, 'product', d.id
      FROM "Purchase" p, "Product" d WHERE p.shortcode = 'PUR-4K7M' AND d.shortcode = 'PRD-4K7M'`);
    const evidence = async () =>
      (
        await client.query(
          `SELECT to_jsonb(e) - 'tender' AS data FROM "PurchasePaymentEvidence" e ORDER BY "evidenceIndex"`,
        )
      ).rows;
    const links = async () =>
      (await client.query(`SELECT to_jsonb(l) AS data FROM "EntityLink" l`))
        .rows;
    const beforeEvidence = await evidence();
    const beforeLinks = await links();
    expect(beforeEvidence).toHaveLength(2);
    expect(beforeLinks).toHaveLength(1);

    await migrateDatabase(drizzle(client), { through: tags[expand]! });

    expect(await evidence()).toEqual(beforeEvidence);
    expect(await links()).toEqual(beforeLinks);
    expect(
      (
        await client.query(
          `SELECT DISTINCT tender FROM "PurchasePaymentEvidence"`,
        )
      ).rows,
    ).toEqual([{ tender: "unknown" }]);
  });
});

import { withMigrationDatabase } from "./test-database-lease";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrationTags, migrateDatabase } from "./db-migrate";

// Adding card access must preserve funding, inventory defaults, and card digits.
it("preserves populated account and purchase history across card-history expansion", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const index = tags.findIndex((tag) =>
      tag.endsWith("_card_user_funding_history"),
    );
    if (index < 1) throw new Error("Card history expansion has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[index - 1]! });
    await client.query(
      `INSERT INTO "LedgerParty" (shortcode, name, kind) VALUES ('LPY-AB12', 'Alex', 'member')`,
    );
    await client.query(
      `INSERT INTO "Vendor" (shortcode, name) VALUES ('VEN-AB12', 'Example Store')`,
    );
    await client.query(`INSERT INTO "FinancialAccount" (shortcode, name, identity, "ledgerPartyId", "inventoryOwnerDefaultEnabled", "cardNumbers")
      SELECT 'FAC-AB12', 'Example card', '{"kind":"credit_card","issuer":"Example Bank","network":"visa"}', id, true,
      '[{"last4":"1234","kind":"primary","validFrom":null,"validTo":null,"note":null}]' FROM "LedgerParty"`);
    await client.query(
      `INSERT INTO "Purchase" (shortcode, "vendorId", date, "statedTotal") SELECT 'PUR-AB12', id, '2026-01-01', 20 FROM "Vendor"`,
    );
    const accounts = async () =>
      (
        await client.query(
          `SELECT shortcode, name, identity, "ledgerPartyId", "inventoryOwnerDefaultEnabled", "cardNumbers" FROM "FinancialAccount"`,
        )
      ).rows;
    const orders = async () =>
      (
        await client.query(
          `SELECT shortcode, "vendorId", date, "statedTotal" FROM "Purchase"`,
        )
      ).rows;
    const before = await accounts();
    const beforeOrders = await orders();
    await migrateDatabase(drizzle(client), { through: tags[index]! });
    expect(await accounts()).toEqual(before);
    expect(await orders()).toEqual(beforeOrders);
    expect(
      (
        await client.query(
          `SELECT "primaryCardholderId", "authorizedUsers", "fundingPeriods" FROM "FinancialAccount"`,
        )
      ).rows,
    ).toEqual([
      { primaryCardholderId: null, authorizedUsers: [], fundingPeriods: [] },
    ]);
    expect(
      (await client.query(`SELECT "purchaserOverrideId" FROM "Purchase"`)).rows,
    ).toEqual([{ purchaserOverrideId: null }]);
  });
});

// Suggestion invalidation DDL must preserve populated card identity and dated histories.
it("preserves card facts when installing account suggestion invalidation", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const index = tags.findIndex((tag) =>
      tag.endsWith("_card_field_suggestions"),
    );
    if (index < 1)
      throw new Error("Account suggestion migration has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[index - 1]! });
    await client.query(
      `INSERT INTO "LedgerParty" (shortcode, name, kind) VALUES ('LPY-4K7M', 'Avery Example', 'member'), ('LPY-7K4M', 'Blair Sample', 'member')`,
    );
    await client.query(`INSERT INTO "FinancialAccount" (shortcode, name, identity, "primaryCardholderId", "authorizedUsers", "fundingPeriods", "cardNumbers")
      SELECT 'FAC-4K7M', 'Example Rewards', '{"kind":"credit_card","issuer":"Example Bank","network":"visa"}', id,
      '[{"ledgerPartyId":"LPY-7K4M","validFrom":"2023-12-27","validTo":null}]', '[{"ledgerPartyId":"LPY-4K7M","validFrom":"2023-10-31","validTo":null}]',
      '[{"last4":"1234","kind":"primary","validFrom":null,"validTo":null,"note":null}]' FROM "LedgerParty" WHERE shortcode = 'LPY-4K7M'`);
    const facts = async () =>
      (
        await client.query(
          `SELECT * FROM "FinancialAccount" WHERE shortcode = 'FAC-4K7M'`,
        )
      ).rows;
    const before = await facts();
    await client.query(`INSERT INTO "AssessmentState" (entity, "recordId", field)
      SELECT 'financialAccount', id, field FROM "FinancialAccount" CROSS JOIN unnest(ARRAY['issuer','network','primaryCardholderId']) field WHERE shortcode = 'FAC-4K7M'`);
    await migrateDatabase(drizzle(client), { through: tags[index]! });
    expect(await facts()).toEqual(before);
    await client.query(
      `UPDATE "FinancialAccount" SET identity = jsonb_set(identity, '{issuer}', '"Sample Bank"') WHERE shortcode = 'FAC-4K7M'`,
    );
    expect((await facts())[0].identity).toEqual({
      kind: "credit_card",
      issuer: "Sample Bank",
      network: "visa",
    });
    expect(
      (
        await client.query(
          `SELECT field, status FROM "AssessmentState" ORDER BY field`,
        )
      ).rows,
    ).toEqual([
      { field: "issuer", status: "superseded" },
      { field: "network", status: "superseded" },
      { field: "primaryCardholderId", status: "superseded" },
    ]);
  });
});

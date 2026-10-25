import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("retains account evidence and explicit cardholders when retiring provisional", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0025_financial_account_providers" });
    const owner = "00000000-0000-4000-8000-000000000001";
    const account = "00000000-0000-4000-8000-000000000002";
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'ledgerParty', 'LPY-SYNTHETIC'), ($2, 'financialAccount', 'FAC-SYNTHETIC')`,
      [owner, account],
    );
    await client.query(
      `INSERT INTO "LedgerParty" (id, shortcode, name, kind) VALUES ($1, 'LPY-SYNTHETIC', 'Synthetic member', 'member')`,
      [owner],
    );
    await client.query(
      `INSERT INTO "FinancialAccount" (id, shortcode, name, identity, "ledgerPartyId", "primaryCardholderId", provisional, notes, "sourceAliases") VALUES ($1, 'FAC-SYNTHETIC', 'Synthetic retained card', '{"kind":"credit_card","network":"visa"}', $2, $2, true, 'Retained synthetic evidence', '[{"source":"test","alias":"Synthetic card","externalAccountId":"synthetic-account"}]')`,
      [account, owner],
    );
    const before = await client.query(
      `SELECT id, shortcode, name, identity, "ledgerPartyId", "primaryCardholderId", notes, "sourceAliases" FROM "FinancialAccount" WHERE id=$1`,
      [account],
    );
    await migrateDatabase(db, {
      through: "0026_account_cardholder_inheritance",
    });
    const after = await client.query(
      `SELECT id, shortcode, name, identity, "ledgerPartyId", "primaryCardholderId", notes, "sourceAliases" FROM "FinancialAccount" WHERE id=$1`,
      [account],
    );
    expect(after.rows).toEqual(before.rows);
    expect(
      (
        await client.query(
          `SELECT "primaryCardholderMode" FROM "FinancialAccount" WHERE id=$1`,
          [account],
        )
      ).rows,
    ).toEqual([{ primaryCardholderMode: "explicit" }]);
    expect(
      (
        await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name='FinancialAccount' AND column_name='provisional'`,
        )
      ).rows,
    ).toEqual([]);
  });
});

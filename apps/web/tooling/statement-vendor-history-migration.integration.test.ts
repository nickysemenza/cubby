import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves money and existing confirmations while retiring routing rules", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0051_work_item_retired_fields_check",
    });
    const vendor = "00000000-0000-4000-8000-000000000011";
    const party = "00000000-0000-4000-8000-000000000012";
    const account = "00000000-0000-4000-8000-000000000013";
    const purchase = "00000000-0000-4000-8000-000000000014";
    const confirmed = "00000000-0000-4000-8000-000000000015";
    const inferred = "00000000-0000-4000-8000-000000000016";
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('synthetic-member','Synthetic member','member@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES
      ($1,'vendor','VEN-SYNTHETIC'),($2,'ledgerParty','LPY-SYNTHETIC'),
      ($3,'financialAccount','FAC-SYNTHETIC'),($4,'purchase','PUR-SYNTHETIC'),
      ($5,'financialTransaction','FTX-CONFIRMED'),($6,'financialTransaction','FTX-INFERRED')`,
      [vendor, party, account, purchase, confirmed, inferred],
    );
    await client.query(
      `INSERT INTO "Vendor" (id,shortcode,name,notes) VALUES ($1,'VEN-SYNTHETIC','Synthetic market','Existing household note')`,
      [vendor],
    );
    await client.query(
      `INSERT INTO "LedgerParty" (id,shortcode,name,kind) VALUES ($1,'LPY-SYNTHETIC','Synthetic member','member')`,
      [party],
    );
    await client.query(
      `INSERT INTO "FinancialAccount" (id,shortcode,name,identity,"ledgerPartyId") VALUES ($1,'FAC-SYNTHETIC','Synthetic card','{"kind":"credit_card","network":"visa"}',$2)`,
      [account, party],
    );
    await client.query(
      `INSERT INTO "Purchase" (id,shortcode,"vendorId",date) VALUES ($1,'PUR-SYNTHETIC',$2,'2026-01-01')`,
      [purchase, vendor],
    );
    await client.query(
      `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",amount,kind,status,merchant,"postedDate") VALUES
      ($1,'FTX-CONFIRMED',$3,10,'purchase','posted','Synthetic Market','2026-01-01'),
      ($2,'FTX-INFERRED',$3,20,'purchase','posted','Unknown Label','2026-01-02')`,
      [confirmed, inferred, account],
    );
    await client.query(
      `INSERT INTO "FinancialTransactionAllocation" ("transactionId","purchaseId",amount) VALUES ($1,$3,10),($2,$3,20)`,
      [confirmed, inferred, purchase],
    );
    await client.query(
      `INSERT INTO "AuditLog" ("entityId","entityKind",action,changes,"userId",channel) VALUES
      ($1,'financialTransaction','update','{"allocations":{"from":[],"to":["PUR-SYNTHETIC:10.00"]}}','synthetic-member','mcp'),
      ($2,'financialTransaction','update','{"allocations":{"from":[],"to":["PUR-SYNTHETIC:20.00"]}}','synthetic-member','system')`,
      [confirmed, inferred],
    );
    await client.query(
      `INSERT INTO "AuditLog" ("entityId","entityKind",action,changes,"userId",channel,"createdAt") VALUES
      ($1,'financialTransaction','update','{"allocations":{"from":["PUR-SYNTHETIC:19.00"],"to":["PUR-SYNTHETIC:20.00"]}}','synthetic-member','mcp',now()+interval '1 second')`,
      [inferred],
    );
    await client.query(
      `INSERT INTO "MerchantVendorRule" ("ledgerPartyId","normalizedMerchant","vendorId","confirmedByUserId") VALUES
      ($1,'synthetic market',$2,'synthetic-member'),($1,'unseen label',$2,'synthetic-member')`,
      [party, vendor],
    );
    const transactions = (
      await client.query(`SELECT * FROM "FinancialTransaction" ORDER BY id`)
    ).rows;
    await migrateDatabase(db, { through: "0053_statement_vendor_history" });
    expect(
      (await client.query(`SELECT * FROM "FinancialTransaction" ORDER BY id`))
        .rows,
    ).toEqual(transactions);
    expect(
      (
        await client.query(
          `SELECT amount,"confirmsMerchant" FROM "FinancialTransactionAllocation" ORDER BY amount`,
        )
      ).rows,
    ).toEqual([
      { amount: 10, confirmsMerchant: true },
      { amount: 20, confirmsMerchant: false },
    ]);
    const notes = (
      await client.query(`SELECT notes FROM "Vendor" WHERE id=$1`, [vendor])
    ).rows[0].notes;
    expect(notes).toBe("Existing household note");
    expect(
      (
        await client.query(
          `SELECT to_regclass('public."MerchantVendorRule"') AS name`,
        )
      ).rows[0].name,
    ).toBeNull();
  });
});

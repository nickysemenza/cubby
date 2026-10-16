import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";
import { z } from "zod";
import { MIGRATIONS_FOLDER, migrateDatabase } from "./db-migrate";
import { testServiceConfig } from "./test-service-config";

// Adding card access must preserve funding, inventory defaults, and card digits.
it("preserves populated account and purchase history across card-history expansion", async () => {
  const service = testServiceConfig();
  const adminUrl = `postgresql://postgres:password@${service.host}:${service.port}/postgres`;
  const name = `cubby_card_history_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.href });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await client.connect();
    const tags = z
      .object({ entries: z.array(z.object({ tag: z.string() })) })
      .parse(
        JSON.parse(
          readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
        ),
      )
      .entries.map((entry) => entry.tag);
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
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});

import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves account evidence and existing references without assigning missing providers", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0024_receipt_expense_binding",
    });
    const provider = "00000000-0000-4000-8000-000000000011";
    const duplicate = "00000000-0000-4000-8000-000000000012";
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'vendor', 'VEN-SYNTHETICBANK'), ($2, 'vendor', 'VEN-SYNTHETICDUP')`,
      [provider, duplicate],
    );
    await client.query(
      `INSERT INTO "Vendor" (id, shortcode, name, aliases) VALUES ($1, 'VEN-SYNTHETICBANK', 'Synthetic Bank', ARRAY['Synthetic Former Bank', 'Ambiguous Bank']), ($2, 'VEN-SYNTHETICDUP', 'Ambiguous Bank', '{}')`,
      [provider, duplicate],
    );
    const cases = [
      { kind: "credit_card", issuer: "Synthetic Bank", network: "visa" },
      {
        kind: "bank_account",
        institution: "Synthetic Former Bank",
        accountType: "checking",
      },
      { kind: "stored_value", provider: "Synthetic Bank" },
      { kind: "other", institution: "Ambiguous Bank" },
      { kind: "other", institution: "Unidentified Synthetic Custodian" },
      { kind: "cash" },
      { kind: "stored_value", provider: "Unrelated historical spelling" },
    ];
    for (const [index, identity] of cases.entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 101).padStart(12, "0")}`;
      const shortcode = `FAC-SYNTHETIC${index}`;
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'financialAccount', $2)`,
        [id, shortcode],
      );
      await client.query(
        `INSERT INTO "FinancialAccount" (id, shortcode, name, identity, "providerVendorId", notes, "sourceAliases", "cardNumbers", "fundingPeriods", "deletedAt") VALUES ($1, $2, 'Synthetic account', $3, $4, 'Retained member notes', '[{"source":"synthetic","alias":"retained","externalAccountId":"source-account"}]', '[{"last4":"1234","kind":"primary","validFrom":null,"validTo":null,"note":"retained"}]', '[]', $5)`,
        [
          id,
          shortcode,
          JSON.stringify(identity),
          index === 6 ? provider : null,
          index === 4 ? "2025-01-01" : null,
        ],
      );
    }
    await client.query(
      `INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment) VALUES ('00000000-0000-4000-8000-000000000201', 'synthetic-retained-issuer', 'field', '{}', '{}')`,
    );
    await client.query(
      `INSERT INTO "AssessmentState" (id, entity, "recordId", field, status, "suggestedValue") VALUES ('00000000-0000-4000-8000-000000000201', 'financialAccount', '00000000-0000-4000-8000-000000000101', 'issuer', 'pending', '"Synthetic Bank"')`,
    );
    const before = (
      await client.query(
        `SELECT * FROM "FinancialAccount" WHERE shortcode LIKE 'FAC-SYNTHETIC%' ORDER BY shortcode`,
      )
    ).rows;
    await migrateDatabase(db, { through: "0025_financial_account_providers" });
    const after = (
      await client.query(
        `SELECT * FROM "FinancialAccount" WHERE shortcode LIKE 'FAC-SYNTHETIC%' ORDER BY shortcode`,
      )
    ).rows;
    expect(after).toHaveLength(cases.length);
    for (const [index, row] of after.entries()) {
      const original = before[index];
      const {
        identity: oldIdentity,
        notes: oldNotes,
        providerVendorId: _oldProvider,
        ...retained
      } = original;
      expect(row).toMatchObject(retained);
      const {
        issuer: _issuer,
        institution: _institution,
        provider: _provider,
        ...identity
      } = oldIdentity;
      expect(row.identity).toEqual(identity);
      expect(row.notes).toContain(oldNotes);
      for (const value of [
        oldIdentity.issuer,
        oldIdentity.institution,
        oldIdentity.provider,
      ].filter(Boolean))
        expect(row.notes).toContain(value);
      expect(row.providerVendorId).toBe(index === 6 ? provider : null);
    }
    expect(
      (
        await client.query(
          `SELECT status, active, "suggestedValue" FROM "AssessmentState" WHERE entity = 'financialAccount' AND field = 'issuer'`,
        )
      ).rows,
    ).toEqual([
      { status: "superseded", active: false, suggestedValue: "Synthetic Bank" },
    ]);
    // A bank and multiple independent balances can share the same provider.
    await client.query(
      `UPDATE "FinancialAccount" SET "providerVendorId" = $1 WHERE shortcode IN ('FAC-SYNTHETIC0', 'FAC-SYNTHETIC1', 'FAC-SYNTHETIC2', 'FAC-SYNTHETIC6')`,
      [provider],
    );
    await expect(
      client.query(
        `UPDATE "FinancialAccount" SET "providerVendorId" = $1 WHERE shortcode = 'FAC-SYNTHETIC5'`,
        [provider],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

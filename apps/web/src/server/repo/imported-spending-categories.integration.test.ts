import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createTestRequestContext } from "~/server/testing/request-context";

import { unwrapDb } from "./database-helpers";
import { createFinancialAccount } from "./financial-account";
import { createFinancialTransaction } from "./financial-transaction";
import {
  applyImportedSpendingCategories,
  previewImportedSpendingCategories,
} from "./imported-spending-categories";
import { insertWithShortcode } from "./shortcode-utils";

// Rollout regressions require real Entity identities, live category matching and
// persisted transactions: a preview must not classify, and stale approval must not overwrite edits.
describe("reviewed imported spending categories", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  async function fixture() {
    const account = await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "Category fixture cash",
        identity: { kind: "cash" },
      }),
      ctx.actor,
    );
    const make = async (
      sourceCategory: string,
      spendingCategoryId: string | null = null,
    ) => {
      const transaction = await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.output.id,
          kind: "purchase",
          status: "posted",
          amount: 25,
          postedDate: "2026-09-01",
          merchant: "Synthetic shop",
          sourceCategory,
        }),
        ctx.actor,
      );
      if (spendingCategoryId) {
        // Legacy rollout data predates the removal of transaction category edits.
        await unwrapDb(ctx.db).execute(
          sql`UPDATE "FinancialTransaction" SET "spendingCategoryId" = (SELECT id FROM "SpendingCategory" WHERE shortcode = ${spendingCategoryId}) WHERE shortcode = ${transaction.output.id}`,
        );
      }
      return transaction;
    };
    return { make };
  }
  it("previews source evidence without promoting statement labels into spending policy", async () => {
    const { make } = await fixture();
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture dining",
      evidenceExpectation: "not_expected",
      productExpectation: "not_expected",
    });
    const preserved = await make("Fixture equipment", category.shortcode);
    const dining = await make("Fixture dining");
    const equipment = await make("Fixture equipment");
    await make("   ");
    const preview = await previewImportedSpendingCategories(ctx.db);
    expect(preview.transactions).toHaveLength(2);
    expect(
      preview.categories.filter((c) => c.existingId === null),
    ).toHaveLength(1);
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT count(*)::int AS count FROM "SpendingCategory" WHERE "deletedAt" IS NULL`,
        )
      ).rows[0]?.count,
    ).toBe(1);
    await expect(
      applyImportedSpendingCategories(context(), preview.fingerprint),
    ).rejects.toThrow(/retired/i);
    const rows = await unwrapDb(ctx.db).execute(
      sql`SELECT shortcode, "spendingCategoryId", "evidenceExpectation", amount FROM "FinancialTransaction" WHERE shortcode IN (${preserved.output.id}, ${dining.output.id}, ${equipment.output.id})`,
    );
    expect(
      rows.rows.find((r) => r.shortcode === preserved.output.id)
        ?.spendingCategoryId,
    ).toBe(category.id);
    expect(
      rows.rows.find((r) => r.shortcode === dining.output.id)
        ?.spendingCategoryId,
    ).toBeNull();
    expect(
      rows.rows.find((r) => r.shortcode === equipment.output.id)
        ?.spendingCategoryId,
    ).toBeNull();
    expect(
      rows.rows.every(
        (r) => r.evidenceExpectation === null && Number(r.amount) === 25,
      ),
    ).toBe(true);
    const replay = await previewImportedSpendingCategories(ctx.db);
    expect(replay.fingerprint).toBe(preview.fingerprint);
    expect(rows.rows.every((row) => Number(row.amount) === 25)).toBe(true);
  });
  it("refuses stale approval and duplicate live names rather than guessing or overwriting", async () => {
    const { make } = await fixture();
    const transaction = await make("Fixture mixed spending");
    const preview = await previewImportedSpendingCategories(ctx.db);
    const choice = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture chosen category",
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET "spendingCategoryId" = ${choice.id} WHERE shortcode = ${transaction.output.id}`,
    );
    await expect(
      applyImportedSpendingCategories(context(), preview.fingerprint),
    ).rejects.toThrow(/retired/i);
    await make("Fixture duplicate");
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture duplicate",
    });
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture duplicate",
    });
    await expect(previewImportedSpendingCategories(ctx.db)).rejects.toThrow(
      /ambiguous/i,
    );
  });
  it("inherits only unanimous linked categories, preserving mixed purchases and ignoring retired categories", async () => {
    const { make } = await fixture();
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture equipment",
      deletedAt: new Date(),
    });
    const equipment = await make("Fixture equipment");
    const dining = await make("Fixture dining");
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture linked shop",
    });
    const unique = await insertWithShortcode(ctx.db, "purchase", {
      date: "2026-09-01",
      vendorId: vendor.id,
    });
    const mixed = await insertWithShortcode(ctx.db, "purchase", {
      date: "2026-09-01",
      vendorId: vendor.id,
    });
    for (const [transaction, purchase] of [
      [equipment, unique],
      [equipment, mixed],
      [dining, mixed],
    ] as const) {
      await unwrapDb(ctx.db).execute(
        sql`INSERT INTO "FinancialTransactionAllocation" ("transactionId", "purchaseId", amount) VALUES ((SELECT id FROM "FinancialTransaction" WHERE shortcode = ${transaction.output.id}), ${purchase.id}, 10)`,
      );
    }
    const preview = await previewImportedSpendingCategories(ctx.db);
    expect(preview.purchases.map((p) => p.id)).toEqual([unique.shortcode]);
    expect(preview.unresolvedPurchases).toBe(1);
    await expect(
      applyImportedSpendingCategories(context(), preview.fingerprint),
    ).rejects.toThrow(/retired/i);
    const result = await unwrapDb(ctx.db).execute(
      sql`SELECT shortcode, "spendingCategoryId" FROM "Purchase" WHERE id IN (${unique.id}, ${mixed.id})`,
    );
    expect(
      result.rows.find((r) => r.shortcode === unique.shortcode)
        ?.spendingCategoryId,
    ).toBeNull();
    expect(
      result.rows.find((r) => r.shortcode === mixed.shortcode)
        ?.spendingCategoryId,
    ).toBeNull();
  });
  it("uses a live replacement charge rather than a void charge's old classification", async () => {
    const { make } = await fixture();
    const old = await make("Fixture retired classification");
    const replacement = await make("Fixture replacement classification");
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET status = 'void' WHERE shortcode = ${old.output.id}`,
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture replacement shop",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      date: "2026-09-01",
      vendorId: vendor.id,
    });
    for (const transaction of [old, replacement])
      await unwrapDb(ctx.db).execute(
        sql`INSERT INTO "FinancialTransactionAllocation" ("transactionId", "purchaseId", amount) VALUES ((SELECT id FROM "FinancialTransaction" WHERE shortcode = ${transaction.output.id}), ${purchase.id}, 10)`,
      );
    const preview = await previewImportedSpendingCategories(ctx.db);
    expect(preview.purchases).toEqual([
      { id: purchase.shortcode, name: "Fixture replacement classification" },
    ]);
    expect(preview.categories.map((c) => c.name)).toEqual([
      "Fixture replacement classification",
    ]);
  });
});

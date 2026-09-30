import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { setDataException } from "./data-quality/exceptions";
import { loadDataQualities } from "./data-quality/hydrate";
import { createFinancialAccount } from "./financial-account";
import { createFinancialTransaction } from "./financial-transaction";
import { mergePurchases, getPurchaseByID } from "./purchase";
import {
  financialTransactionCoverageSql,
  purchaseCoverageSql,
  purchaseEvidenceExpectationSql,
} from "./purchase-evidence-policy";
import { createImageFixture, insertEntityAttachments } from "./repo.fixtures";

// SQL regressions: policy precedence must survive correlated aliases; missing
// catalog identity must not erase line itemization; optional documents and
// orderless bookings must not lower the quality denominator. PostgreSQL runs
// the same expressions used by hydration, list filtering, and score sorting.
describe("purchase evidence policy", () => {
  const ctx = withTestDb();

  async function fixture() {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture merchandise",
      evidenceExpectation: "required",
      productExpectation: "required",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture shop",
      evidenceExpectation: "not_expected",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      spendingCategoryId: category.id,
      date: "2026-09-01",
    });
    return { category, vendor, purchase };
  }

  it("uses explicit Purchase policy before Vendor and category defaults, including unknown", async () => {
    const { purchase } = await fixture();
    const policy = async () => {
      const result = await unwrapDb(ctx.db).execute(sql`
        SELECT ${purchaseEvidenceExpectationSql("p")} AS policy
        FROM "Purchase" p WHERE p.id = ${purchase.id}
      `);
      return result.rows[0]?.policy;
    };
    expect(await policy()).toBe("not_expected");
    await unwrapDb(ctx.db).execute(sql`
      UPDATE "Purchase" SET "evidenceExpectation" = 'required'
      WHERE id = ${purchase.id}
    `);
    expect(await policy()).toBe("required");
    await unwrapDb(ctx.db).execute(sql`
      UPDATE "Purchase" SET "evidenceExpectation" = 'unknown'
      WHERE id = ${purchase.id}
    `);
    expect(await policy()).toBe("unknown");
  });

  it("keeps an orderless optional-receipt booking out of paperwork gaps", async () => {
    const { purchase } = await fixture();
    await insertWithShortcode(ctx.db, "expense", {
      name: "Reviewed statement booking",
      purchaseId: purchase.id,
      cost: 25,
      date: "2026-09-01",
      costType: "materials",
      lineBasis: "allocation",
      economicRole: "vendor",
    });
    const quality = (
      await loadDataQualities(ctx.db, "purchase", [purchase.id])
    ).get(purchase.id);
    for (const check of [
      "order_id",
      "stated_total",
      "primary_document",
      "purchase_itemization",
    ])
      expect(quality?.gaps.map((gap) => gap.check)).not.toContain(check);
  });

  it("keeps verified itemization present when the goods Product is unresolved", async () => {
    const { purchase } = await fixture();
    await unwrapDb(ctx.db).execute(sql`
      UPDATE "Purchase" SET "evidenceExpectation" = 'required', "itemizationEvidence" = true
      WHERE id = ${purchase.id}
    `);
    await insertWithShortcode(ctx.db, "expense", {
      name: "Unresolved fixture item",
      purchaseId: purchase.id,
      cost: 25,
      date: "2026-09-01",
      costType: "materials",
      lineBasis: "item_line",
      economicRole: "vendor",
    });
    const result = await unwrapDb(ctx.db).execute(sql`
      SELECT ${purchaseCoverageSql("p")} AS coverage
      FROM "Purchase" p WHERE p.id = ${purchase.id}
    `);
    expect(result.rows[0]?.coverage).toMatchObject({
      booking: "recorded",
      itemization: "present",
      products: "missing",
    });
  });
  it("carries receipt policy and refuses silently discarding conflicting Purchase policy", async () => {
    const { purchase: donor, vendor, category } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "evidenceExpectation" = 'required' WHERE id = ${donor.id}`,
    );
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      evidenceExpectation: "not_expected",
    });
    await expect(
      mergePurchases(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [donor.shortcode] },
        ctx.actor,
      ),
    ).rejects.toThrow(/expectation/i);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "evidenceExpectation" = NULL WHERE id = ${keeper.id}`,
    );
    await mergePurchases(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [donor.shortcode] },
      ctx.actor,
    );
    expect(await getPurchaseByID(ctx.db, keeper.id)).toMatchObject({
      evidenceExpectation: "required",
      spendingCategoryId: category.shortcode,
    });
  });
  it("uses transaction receipt policy before a Purchase allocation exists", async () => {
    const account = await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "Policy fixture cash",
        identity: { kind: "cash" },
      }),
      ctx.actor,
    );
    const transaction = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.output.id,
        amount: 25,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-01",
        evidenceExpectation: "not_expected",
      }),
      ctx.actor,
    );
    const read = async () =>
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT ${financialTransactionCoverageSql("t")} AS coverage FROM "FinancialTransaction" t WHERE id = ${transaction.entityId}`,
        )
      ).rows[0]?.coverage;
    expect(await read()).toMatchObject({
      booking: "missing",
      document: "not_expected",
      itemization: "not_expected",
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET "evidenceExpectation" = 'required' WHERE id = ${transaction.entityId}`,
    );
    expect(await read()).toMatchObject({
      booking: "missing",
      document: "missing",
      itemization: "missing",
    });
  });

  it("scores required transaction evidence and goods identity while excluding optional evidence", async () => {
    const { purchase, category } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "evidenceExpectation" = 'required' WHERE id = ${purchase.id}`,
    );
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: purchase.id,
      name: "Required goods line",
      cost: 25,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
    });
    const account = await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "Quality fixture cash",
        identity: { kind: "cash" },
      }),
      ctx.actor,
    );
    const transaction = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.output.id,
        amount: 25,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-01",
        merchant: "Quality fixture goods",
        spendingCategoryId: category.shortcode,
        purchaseId: purchase.shortcode,
      }),
      ctx.actor,
    );
    const quality = async () =>
      (
        await loadDataQualities(ctx.db, "financialTransaction", [
          transaction.entityId,
        ])
      ).get(transaction.entityId);
    const required = await quality();
    expect(required?.gaps.map((gap) => gap.check)).toEqual(
      expect.arrayContaining([
        "financial_transaction_document",
        "financial_transaction_itemization",
        "financial_transaction_products",
      ]),
    );
    expect(required?.score).toBeLessThan(100);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "evidenceExpectation" = 'not_expected' WHERE id = ${purchase.id}`,
    );
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "SpendingCategory" SET "productExpectation" = 'not_expected' WHERE id = ${category.id}`,
    );
    expect(await quality()).toMatchObject({ score: 100, gaps: [] });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET kind = 'account_transfer' WHERE id = ${transaction.entityId}`,
    );
    expect(await quality()).toMatchObject({ score: 100, gaps: [] });
  });

  it.each(["reimbursement", "vendor", "mixed"] as const)(
    "keeps %s credit coverage tied to its explicit economic role",
    async (role) => {
      const { purchase, category } = await fixture();
      await unwrapDb(ctx.db).execute(
        sql`UPDATE "Purchase" SET "evidenceExpectation" = 'required' WHERE id = ${purchase.id}`,
      );
      await insertWithShortcode(ctx.db, "expense", {
        purchaseId: purchase.id,
        name: "Required merchandise",
        cost: 25,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
      });
      const account = await createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name: "Credit policy cash",
          identity: { kind: "cash" },
        }),
        ctx.actor,
      );
      const transaction = await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.output.id,
          amount: -10,
          kind: role === "vendor" ? "refund" : "income",
          status: "posted",
          postedDate: "2026-09-01",
          merchant: "Reviewed credit",
          spendingCategoryId: category.shortcode,
          purchaseId: purchase.shortcode,
        }),
        ctx.actor,
      );
      await insertWithShortcode(ctx.db, "expense", {
        purchaseId: purchase.id,
        name: "Reviewed credit booking",
        cost: -10,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        economicRole: role === "vendor" ? "vendor" : "reimbursement",
        lineBasis: "allocation",
        bookingTransactionCode: transaction.output.id,
      });
      if (role === "mixed")
        await insertWithShortcode(ctx.db, "expense", {
          purchaseId: purchase.id,
          name: "Mixed vendor booking",
          cost: 0,
          date: "2026-09-01",
          costType: "materials",
          trade: "other",
          economicRole: "vendor",
          lineBasis: "allocation",
          bookingTransactionCode: transaction.output.id,
        });
      const coverage = (
        await unwrapDb(ctx.db).execute(
          sql`SELECT ${financialTransactionCoverageSql("t")} AS coverage FROM "FinancialTransaction" t WHERE id = ${transaction.entityId}`,
        )
      ).rows[0]?.coverage;
      expect(coverage).toMatchObject(
        role === "reimbursement"
          ? {
              booking: "recorded",
              expectation: "not_expected",
              document: "not_expected",
              itemization: "not_expected",
              products: "not_expected",
            }
          : {
              booking: "recorded",
              expectation: "required",
              document: "missing",
              itemization: "missing",
              products: "missing",
            },
      );
      const quality = (
        await loadDataQualities(ctx.db, "financialTransaction", [
          transaction.entityId,
        ])
      ).get(transaction.entityId);
      expect(quality).toMatchObject(
        role === "reimbursement"
          ? { score: 100, gaps: [] }
          : { status: "needs_data" },
      );
      expect(quality?.gaps.map((gap) => gap.check)).toEqual(
        expect.arrayContaining(
          role === "reimbursement"
            ? []
            : [
                "financial_transaction_document",
                "financial_transaction_itemization",
                "financial_transaction_products",
              ],
        ),
      );
    },
  );

  it.each(["unavailable", "history_expired"] as const)(
    "accepts %s itemization history and reopens it when new receipt evidence arrives",
    async (reason) => {
      const { purchase } = await fixture();
      await unwrapDb(ctx.db).execute(
        sql`UPDATE "Purchase" SET "evidenceExpectation" = 'required' WHERE id = ${purchase.id}`,
      );
      await insertWithShortcode(ctx.db, "expense", {
        purchaseId: purchase.id,
        name: "Historical reviewed aggregate",
        cost: 25,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        lineBasis: "allocation",
      });
      const accepted = await setDataException(
        ctx.db,
        {
          entityId: purchase.shortcode,
          check: "purchase_itemization",
          reason,
          note: "Synthetic historical vendor details are unavailable.",
        },
        ctx.actor,
      );
      expect(accepted.gaps.map((gap) => gap.check)).not.toContain(
        "purchase_itemization",
      );
      expect(accepted.exceptions).toContainEqual(
        expect.objectContaining({
          check: "purchase_itemization",
          state: "active",
        }),
      );
      const image = await createImageFixture(ctx.db, `itemization-${reason}`);
      await insertEntityAttachments(ctx.db, {
        entityId: purchase.id,
        imageId: image.id,
        role: "attachment",
        documentKind: "receipt",
      });
      const reopened = (
        await loadDataQualities(ctx.db, "purchase", [purchase.id])
      ).get(purchase.id);
      expect(reopened?.gaps.map((gap) => gap.check)).toContain(
        "purchase_itemization",
      );
      expect(reopened?.exceptions).toContainEqual(
        expect.objectContaining({
          check: "purchase_itemization",
          state: "stale",
        }),
      );
    },
  );
});

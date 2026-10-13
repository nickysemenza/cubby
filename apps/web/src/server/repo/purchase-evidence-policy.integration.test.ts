import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityLink, expense } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";
import { linkValues } from "~/server/repo/entity-links";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { setDataException } from "./data-quality/exceptions";
import { loadDataQualities } from "./data-quality/hydrate";
import { mergePurchases, getPurchaseByID } from "./purchase";
import {
  financialTransactionCoverageSql,
  purchaseCoverageSql,
  purchaseItemizationExpectationSql,
} from "./purchase-evidence-policy";
import { createImageFixture, insertEntityAttachments } from "./repo.fixtures";

// SQL regressions: policy precedence must survive correlated aliases;
// itemization is the line shape, not a stored flag; optional documents and
// orderless bookings must not lower the quality denominator. PostgreSQL runs
// the same expressions used by hydration, list filtering, and score sorting.
describe("purchase evidence policy", () => {
  const ctx = withTestDb();

  async function fixture() {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture merchandise",
      itemizationExpectation: "required",
      productExpectation: "required",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture shop",
      itemizationExpectation: "not_expected",
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
        SELECT ${purchaseItemizationExpectationSql("p")} AS policy
        FROM "Purchase" p WHERE p.id = ${purchase.id}
      `);
      return result.rows[0]?.policy;
    };
    expect(await policy()).toBe("not_expected");
    await unwrapDb(ctx.db).execute(sql`
      UPDATE "Purchase" SET "itemizationExpectation" = 'required'
      WHERE id = ${purchase.id}
    `);
    expect(await policy()).toBe("required");
    await unwrapDb(ctx.db).execute(sql`
      UPDATE "Purchase" SET "itemizationExpectation" = 'unknown'
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
    for (const check of ["order_id", "stated_total", "purchase_itemization"])
      expect(quality?.gaps.map((gap) => gap.check)).not.toContain(check);
  });

  // Regression: itemization was a stored review flag that only one import path
  // set, so ~2,700 item-lined online orders read "not reviewed". It is now the
  // line shape: every expected Product linked, services and adjustments exempt,
  // no allocation slice, and no document required.
  it("derives itemization from the order's lines", async () => {
    const { purchase } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = 'required' WHERE id = ${purchase.id}`,
    );
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture hardware cloth",
      manufacturer: "Fixture maker",
    });
    const line = (values: Partial<typeof expense.$inferInsert>) =>
      insertWithShortcode(ctx.db, "expense", {
        name: "Fixture line",
        purchaseId: purchase.id,
        cost: 10,
        date: "2026-09-01",
        costType: "materials",
        lineKind: "principal",
        lineBasis: "item_line",
        economicRole: "vendor",
        ...values,
      });
    const state = async () => {
      const result = await unwrapDb(ctx.db).execute(sql`
        SELECT ${purchaseCoverageSql("p")} AS coverage
        FROM "Purchase" p WHERE p.id = ${purchase.id}
      `);
      const quality = (
        await loadDataQualities(ctx.db, "purchase", [purchase.id])
      ).get(purchase.id);
      return {
        coverage: result.rows[0]?.coverage,
        gaps: quality?.gaps.map((gap) => gap.check) ?? [],
      };
    };

    await line({ productId: product.id, productQuantity: 1 });
    await line({ name: "Fixture tax", lineKind: "tax" });
    await line({ name: "Fixture install labor", costType: "services" });
    expect(await state()).toMatchObject({
      coverage: { itemization: "present", document: "not_expected" },
    });
    expect((await state()).gaps).not.toContain("purchase_itemization");

    const lump = await line({ name: "Fixture unitemized goods" });
    expect(await state()).toMatchObject({
      coverage: { itemization: "missing", products: "partial" },
    });
    expect((await state()).gaps).toContain("purchase_itemization");

    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET "lineBasis" = 'allocation' WHERE id = ${lump.id}`,
    );
    expect(await state()).toMatchObject({
      coverage: { itemization: "missing" },
    });
  });

  // Regression: goods paid as a deposit and balance are recorded as allocation
  // lines plus purchaseProduct links, the shape the import writers produce, but
  // the rule only looked for Products on item lines and kept them in the queue.
  it("counts instalment-paid goods itemized through their linked Products", async () => {
    const { purchase } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = ${itemizationExpectation.enum.required} WHERE id = ${purchase.id}`,
    );
    for (const name of ["Fixture deposit", "Fixture balance"])
      await insertWithShortcode(ctx.db, "expense", {
        name,
        purchaseId: purchase.id,
        cost: 500,
        date: "2026-09-01",
        costType: "materials",
        lineKind: "principal",
        lineBasis: "allocation",
        economicRole: "vendor",
      });
    const itemization = async () => {
      const result = await unwrapDb(ctx.db).execute(sql`
        SELECT ${purchaseCoverageSql("p")}->>'itemization' AS itemization
        FROM "Purchase" p WHERE p.id = ${purchase.id}
      `);
      const quality = (
        await loadDataQualities(ctx.db, "purchase", [purchase.id])
      ).get(purchase.id);
      return {
        coverage: result.rows[0]?.itemization,
        gap: quality?.gaps.some((gap) => gap.check === "purchase_itemization"),
      };
    };
    expect(await itemization()).toEqual({ coverage: "missing", gap: true });

    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture steel planter",
      manufacturer: "Fixture maker",
    });
    await unwrapDb(ctx.db)
      .insert(entityLink)
      .values(linkValues("purchaseProduct", purchase.id, product.id));
    expect(await itemization()).toEqual({ coverage: "present", gap: false });
  });

  it("carries itemization policy and refuses silently discarding conflicting Purchase policy", async () => {
    const { purchase: donor, vendor, category } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = 'required' WHERE id = ${donor.id}`,
    );
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      itemizationExpectation: "not_expected",
    });
    await expect(
      mergePurchases(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [donor.shortcode] },
        ctx.actor,
      ),
    ).rejects.toThrow(/expectation/i);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = NULL WHERE id = ${keeper.id}`,
    );
    await mergePurchases(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [donor.shortcode] },
      ctx.actor,
    );
    expect(await getPurchaseByID(ctx.db, keeper.id)).toMatchObject({
      itemizationExpectation: "required",
      spendingCategoryId: category.shortcode,
    });
  });
  it("uses transaction itemization policy before a Purchase allocation exists", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Policy fixture cash",
      identity: { kind: "cash" },
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 25,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-01",
      itemizationExpectation: "not_expected",
    });
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
      sql`UPDATE "FinancialTransaction" SET "itemizationExpectation" = 'required' WHERE id = ${transaction.entityId}`,
    );
    expect(await read()).toMatchObject({
      booking: "missing",
      document: "not_expected",
      itemization: "missing",
    });
  });

  it("scores required transaction evidence and goods identity while excluding optional evidence", async () => {
    const { purchase, category } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = 'required' WHERE id = ${purchase.id}`,
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
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Quality fixture cash",
      identity: { kind: "cash" },
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 25,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-01",
      merchant: "Quality fixture goods",
      purchaseId: purchase.shortcode,
    });
    const quality = async () =>
      (
        await loadDataQualities(ctx.db, "financialTransaction", [
          transaction.entityId,
        ])
      ).get(transaction.entityId);
    const required = await quality();
    // An item-lined order missing a Product is one gap: the products axis,
    // not itemization too.
    expect(required?.gaps.map((gap) => gap.check)).toEqual([
      "financial_transaction_products",
    ]);
    expect(required?.score).toBeLessThan(100);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = 'not_expected' WHERE id = ${purchase.id}`,
    );
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "SpendingCategory" SET "productExpectation" = 'not_expected' WHERE id = ${category.id}`,
    );
    expect(await quality()).toMatchObject({ score: 100, gaps: [] });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET kind = 'account_transfer' WHERE id = ${transaction.entityId}`,
    );
    const transferQuality = await quality();
    expect(transferQuality).toMatchObject({ status: "defect" });
    expect(transferQuality?.score).toBeLessThanOrEqual(49);
    expect(transferQuality?.gaps.map((gap) => gap.check)).toEqual([
      "financial_transaction_allocation_integrity",
    ]);
  });

  it.each(["reimbursement", "vendor", "mixed"] as const)(
    "keeps %s credit coverage tied to its explicit economic role",
    async (role) => {
      const { purchase } = await fixture();
      await unwrapDb(ctx.db).execute(
        sql`UPDATE "Purchase" SET "itemizationExpectation" = 'required' WHERE id = ${purchase.id}`,
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
      const account = await createRepoEntity(ctx, "financialAccount", {
        name: "Credit policy cash",
        identity: { kind: "cash" },
      });
      const transaction = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount: -10,
        kind: role === "vendor" ? "refund" : "income",
        status: "posted",
        postedDate: "2026-09-01",
        merchant: "Reviewed credit",
        purchaseId: purchase.shortcode,
      });
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
              document: "not_expected",
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
                "financial_transaction_itemization",
                "financial_transaction_products",
              ],
        ),
      );
    },
  );

  // Regression: the line fingerprint hashes the whole Expense row, so adding
  // the productNotExpected column reopened every accepted itemization gap.
  it("keeps an accepted itemization gap accepted when Expense gains productNotExpected", async () => {
    const { purchase } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = 'required' WHERE id = ${purchase.id}`,
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
    await unwrapDb(ctx.db).execute(
      sql`ALTER TABLE "Expense" DROP COLUMN IF EXISTS "productNotExpected"`,
    );
    await setDataException(
      ctx.db,
      {
        entityId: purchase.shortcode,
        check: "purchase_itemization",
        reason: "unavailable",
        note: "Synthetic historical vendor details are unavailable.",
      },
      ctx.actor,
    );
    // The migration adds the column with its default to every row.
    await unwrapDb(ctx.db).execute(
      sql`ALTER TABLE "Expense" ADD COLUMN "productNotExpected" boolean DEFAULT false NOT NULL`,
    );
    const after = (
      await loadDataQualities(ctx.db, "purchase", [purchase.id])
    ).get(purchase.id);
    expect(after?.exceptions).toContainEqual(
      expect.objectContaining({
        check: "purchase_itemization",
        state: "active",
      }),
    );
  });

  it.each(["unavailable", "history_expired"] as const)(
    "accepts %s itemization history and reopens it when new receipt evidence arrives",
    async (reason) => {
      const { purchase } = await fixture();
      await unwrapDb(ctx.db).execute(
        sql`UPDATE "Purchase" SET "itemizationExpectation" = 'required' WHERE id = ${purchase.id}`,
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

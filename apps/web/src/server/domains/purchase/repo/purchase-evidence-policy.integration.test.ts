import type { FinancialTransactionStatus } from "@cubby/schemas/financial-transaction-fields";
import type { VendorId } from "@cubby/schemas/identifiers";
import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import {
  entityLink,
  expense,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { financialTransactionItemizationSql } from "~/server/domains/financial-transaction/repo/financial-reconciliation";
import {
  findOrCreateVendor,
  readVendorById,
} from "~/server/domains/vendor/repo/vendor";
import { setDataException } from "~/server/generic/data-quality/repo/exceptions";
import { loadDataQualities as readDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { linkValues } from "~/server/generic/entity-links/repo/entity-links";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { publishQualityFixtures } from "~/server/testing/quality.fixtures";
import {
  createImageFixture,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";

import { mergePurchases, readPurchaseById } from "./purchase";
import {
  financialTransactionCoverageSql,
  purchaseCoverageSql,
  purchaseItemizationExpectationSql,
} from "./purchase-evidence-policy";

// SQL regressions: policy precedence must survive correlated aliases;
// itemization is the line shape, not a stored flag; optional documents and
// orderless bookings must not lower the quality denominator. PostgreSQL runs
// the same expressions used by hydration, list filtering, and score sorting.
describe("purchase evidence policy", () => {
  const ctx = withTestDb();
  const loadDataQualities: typeof readDataQualities = async (...args) => {
    await publishQualityFixtures(ctx.db, "purchase");
    return readDataQualities(...args);
  };

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
      lineKind: "principal",
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
      brandId: await findOrCreateVendor(ctx.db, "Fixture maker"),
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
  // A reimbursement slice is not the vendor's order shape, an unlinked goods
  // line still blocks, and the charge verdict reads the same shape.
  it("counts instalment-paid goods itemized through their linked Products", async () => {
    const { purchase } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = ${itemizationExpectation.enum.required} WHERE id = ${purchase.id}`,
    );
    // The reimbursed slice is $0 so the charge still matches the vendor lines.
    const slice = (name: string, economicRole: "vendor" | "reimbursement") =>
      insertWithShortcode(ctx.db, "expense", {
        name,
        purchaseId: purchase.id,
        cost: economicRole === "vendor" ? 500 : 0,
        date: "2026-09-01",
        costType: "materials",
        lineKind: "principal",
        lineBasis: "allocation",
        economicRole,
      });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Fixture instalment card",
      identity: { kind: "cash" },
    });
    const charge = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: account.id,
      amount: 1000,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-01",
      merchant: "Fixture instalment merchant",
    });
    await unwrapDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: charge.id,
      purchaseId: purchase.id,
      amount: 1000,
    });
    const itemization = async () => {
      await publishQualityFixtures(ctx.db, "purchase");
      const result = await unwrapDb(ctx.db).execute(sql`
        SELECT ${purchaseCoverageSql("p")}->>'itemization' AS itemization,
          (SELECT ${financialTransactionItemizationSql("ft.id")}
            FROM "FinancialTransaction" ft WHERE ft.id = ${charge.id}) AS verdict
        FROM "Purchase" p WHERE p.id = ${purchase.id}
      `);
      const quality = (
        await loadDataQualities(ctx.db, "purchase", [purchase.id])
      ).get(purchase.id);
      return {
        coverage: result.rows[0]?.itemization,
        verdict: result.rows[0]?.verdict,
        gap: quality?.gaps.some((gap) => gap.check === "purchase_itemization"),
      };
    };
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture steel planter",
      brandId: await findOrCreateVendor(ctx.db, "Fixture maker"),
    });
    await unwrapDb(ctx.db)
      .insert(entityLink)
      .values(linkValues("purchaseProduct", purchase.id, product.id));
    await slice("Fixture reimbursed share", "reimbursement");
    expect(await itemization()).toMatchObject({
      coverage: "missing",
      gap: true,
    });

    await slice("Fixture deposit", "vendor");
    await slice("Fixture balance", "vendor");
    expect(await itemization()).toEqual({
      coverage: "present",
      verdict: "itemized_match",
      gap: false,
    });

    const unlinked = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture unlinked goods",
      purchaseId: purchase.id,
      cost: 0,
      date: "2026-09-01",
      costType: "materials",
      lineKind: "principal",
      lineBasis: "item_line",
      economicRole: "vendor",
    });
    expect(await itemization()).toMatchObject({
      coverage: "missing",
      gap: true,
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET "deletedAt" = now() WHERE id = ${unlinked.id}`,
    );
    expect(await itemization()).toMatchObject({
      coverage: "present",
      gap: false,
    });
  });

  // New linked goods do not revoke a retained member waiver.
  it("retains an itemization waiver when a Product is linked", async () => {
    const { purchase } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = ${itemizationExpectation.enum.required} WHERE id = ${purchase.id}`,
    );
    await setDataException(
      ctx.db,
      {
        entityId: purchase.shortcode,
        check: "purchase_itemization",
        reason: "unavailable",
        note: "Synthetic order history is unavailable.",
      },
      ctx.actor,
    );
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture linked good",
      brandId: await findOrCreateVendor(ctx.db, "Fixture maker"),
    });
    await unwrapDb(ctx.db)
      .insert(entityLink)
      .values(linkValues("purchaseProduct", purchase.id, product.id));
    const retained = (
      await loadDataQualities(ctx.db, "purchase", [purchase.id])
    ).get(purchase.id);
    expect(retained?.gaps.map((gap) => gap.check)).not.toContain(
      "purchase_itemization",
    );
    expect(retained?.exceptions).toContainEqual(
      expect.objectContaining({
        check: "purchase_itemization",
        state: "active",
      }),
    );
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
    expect(await readPurchaseById(ctx.db, keeper.id)).toMatchObject({
      itemizationExpectation: "required",
      spendingCategoryId: category.shortcode,
    });
  });
  it.each([
    "posted",
    "pending",
    "observed",
  ] satisfies FinancialTransactionStatus[])(
    "uses %s transaction itemization policy before a Purchase allocation exists",
    async (status) => {
      const account = await createRepoEntity(ctx, "financialAccount", {
        name: "Policy fixture cash",
        identity: { kind: "cash" },
      });
      const transaction = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount: 25,
        kind: "purchase",
        status,
        transactionDate: "2026-09-01",
        postedDate: status === "posted" ? "2026-09-01" : null,
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
    },
  );

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
    // Missing Product identity affects the products axis, not itemization.
    // Display media remains a separate requirement.
    expect(required?.gaps.map((gap) => gap.check)).toEqual([
      "financial_transaction_products",
      "financialtransaction_display_image",
    ]);
    expect(required?.score).toBeLessThan(100);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = 'not_expected' WHERE id = ${purchase.id}`,
    );
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "SpendingCategory" SET "productExpectation" = 'not_expected' WHERE id = ${category.id}`,
    );
    expect(await quality()).toMatchObject({
      score: 99,
      gaps: [{ check: "financialtransaction_display_image" }],
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET kind = 'account_transfer' WHERE id = ${transaction.entityId}`,
    );
    const transferQuality = await quality();
    expect(transferQuality).toMatchObject({ status: "defect" });
    expect(transferQuality?.score).toBeLessThanOrEqual(49);
    expect(transferQuality?.gaps.map((gap) => gap.check)).toEqual([
      "financial_transaction_allocation_integrity",
      "financialtransaction_display_image",
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
        lineKind: "principal",
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
          lineKind: "principal",
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
          ? {
              score: 99,
              gaps: [{ check: "financialtransaction_display_image" }],
            }
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

  // Changes to line policy metadata preserve a retained itemization waiver.
  it("keeps an accepted itemization gap accepted when Expense gains productNotExpected", async () => {
    const { purchase } = await fixture();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "itemizationExpectation" = 'required' WHERE id = ${purchase.id}`,
    );
    await insertWithShortcode(ctx.db, "expense", {
      lineKind: "principal",
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
    "retains %s itemization history when new receipt evidence arrives",
    async (reason) => {
      const { purchase } = await fixture();
      await unwrapDb(ctx.db).execute(
        sql`UPDATE "Purchase" SET "itemizationExpectation" = 'required' WHERE id = ${purchase.id}`,
      );
      await insertWithShortcode(ctx.db, "expense", {
        lineKind: "principal",
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
      const retained = (
        await loadDataQualities(ctx.db, "purchase", [purchase.id])
      ).get(purchase.id);
      expect(retained?.gaps.map((gap) => gap.check)).not.toContain(
        "purchase_itemization",
      );
      expect(retained?.exceptions).toContainEqual(
        expect.objectContaining({
          check: "purchase_itemization",
          state: "active",
        }),
      );
    },
  );
});

// A Vendor's order evidence supplies its itemization default: an online
// account means item lines are expected, no evidence means not expected, and
// a receipt-only or unrecorded vendor stays unclassified (no value, labelled
// Unclassified, distinct from an explicit `unknown`). An explicit Vendor
// value always wins, and an unclassified default must not mask the spending
// category's policy downstream.
describe("vendor itemization default from order evidence", () => {
  const ctx = withTestDb();

  const vendorWith = (
    orderEvidence: "online_account" | "receipt_only" | "not_expected" | null,
    stored: (typeof itemizationExpectation.options)[number] | null = null,
  ) =>
    insertWithShortcode(ctx.db, "vendor", {
      name: `Fixture vendor ${orderEvidence ?? "none"} ${stored ?? "derived"}`,
      orderEvidence,
      itemizationExpectation: stored,
    });

  it.each([
    ["online_account", "required"],
    ["not_expected", "not_expected"],
    ["receipt_only", null],
    [null, null],
  ] as const)(
    "derives %s order evidence as %s",
    async (orderEvidence, expected) => {
      const vendor = await vendorWith(orderEvidence);
      const read = await readVendorById(ctx.db, vendor.id);
      expect(read.itemizationExpectation).toBeNull();
      expect(read.fieldResolutions?.itemizationExpectation).toMatchObject({
        mode: "inherit",
        storedValue: null,
        value: expected,
        fallbackValue: expected,
        canReset: false,
      });
    },
  );

  it("keeps an explicit Vendor value over its order evidence", async () => {
    const vendor = await vendorWith("online_account", "not_expected");
    const read = await readVendorById(ctx.db, vendor.id);
    expect(read.fieldResolutions?.itemizationExpectation).toMatchObject({
      mode: "explicit",
      storedValue: "not_expected",
      value: "not_expected",
      fallbackValue: "required",
      canReset: true,
    });
  });

  // Regression: an unclassified fallback read as `unknown`, so a receipt-only
  // Vendor's explicit `unknown` looked redundant; clearing it let the
  // Purchase fall through to its category and flip to required. A stored
  // value is redundant only when clearing it leaves downstream policy as is.
  it("treats a stored value as redundant only when clearing it keeps downstream policy", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture hardware",
      itemizationExpectation: "required",
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Fixture redundancy card",
      identity: { kind: "cash" },
    });
    const downstream = async (vendorId: VendorId) => {
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId,
        spendingCategoryId: category.id,
        date: "2026-09-01",
      });
      const charge = await insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: account.id,
        amount: 25,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-01",
        merchant: `Fixture merchant ${purchase.shortcode}`,
      });
      await unwrapDb(ctx.db).insert(financialTransactionAllocation).values({
        transactionId: charge.id,
        purchaseId: purchase.id,
        amount: 25,
      });
      return async () => {
        const result = await unwrapDb(ctx.db).execute(sql`
          SELECT ${purchaseItemizationExpectationSql("p")} AS purchase,
            (SELECT ${financialTransactionCoverageSql("t")}->>'expectation'
             FROM "FinancialTransaction" t WHERE t.id = ${charge.id}) AS transaction
          FROM "Purchase" p WHERE p.id = ${purchase.id}
        `);
        return result.rows[0];
      };
    };
    const clear = (vendorId: VendorId) =>
      unwrapDb(ctx.db).execute(
        sql`UPDATE "Vendor" SET "itemizationExpectation" = NULL WHERE id = ${vendorId}`,
      );

    const explicitUnknown = await vendorWith("receipt_only", "unknown");
    const unknownPolicy = await downstream(explicitUnknown.id);
    expect(await unknownPolicy()).toEqual({
      purchase: "unknown",
      transaction: "unknown",
    });
    const unknownRead = await readVendorById(ctx.db, explicitUnknown.id);
    expect(unknownRead.fieldResolutions?.itemizationExpectation).toMatchObject({
      mode: "explicit",
      fallbackValue: null,
      matchesFallback: false,
    });
    await clear(explicitUnknown.id);
    expect(await unknownPolicy()).toEqual({
      purchase: "required",
      transaction: "required",
    });

    const matchingOverride = await vendorWith("online_account", "required");
    const matchingPolicy = await downstream(matchingOverride.id);
    const matchingRead = await readVendorById(ctx.db, matchingOverride.id);
    expect(matchingRead.fieldResolutions?.itemizationExpectation).toMatchObject(
      { mode: "explicit", fallbackValue: "required", matchesFallback: true },
    );
    const before = await matchingPolicy();
    await clear(matchingOverride.id);
    expect(await matchingPolicy()).toEqual(before);
  });

  it("feeds the derived Vendor value to Purchase and transaction policy", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture dining",
      itemizationExpectation: "not_expected",
    });
    const online = await vendorWith("online_account");
    const receiptOnly = await vendorWith("receipt_only");
    const purchaseFor = (vendorId: typeof online.id) =>
      insertWithShortcode(ctx.db, "purchase", {
        vendorId,
        spendingCategoryId: category.id,
        date: "2026-09-01",
      });
    const onlinePurchase = await purchaseFor(online.id);
    const receiptPurchase = await purchaseFor(receiptOnly.id);

    const onlineRead = await readPurchaseById(ctx.db, onlinePurchase.id);
    expect(onlineRead.fieldResolutions?.itemizationExpectation).toMatchObject({
      mode: "inherit",
      value: "required",
      source: "vendor policy",
      sourceEntity: expect.objectContaining({
        entityKind: "vendor",
        entityId: online.shortcode,
      }),
    });
    // Receipt-only implies nothing, so the category's policy still decides.
    const receiptRead = await readPurchaseById(ctx.db, receiptPurchase.id);
    expect(receiptRead.fieldResolutions?.itemizationExpectation).toMatchObject({
      value: "not_expected",
      source: "spending category policy",
    });

    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Fixture online card",
      identity: { kind: "cash" },
    });
    const charge = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: account.id,
      amount: 25,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-01",
      merchant: "Fixture online merchant",
    });
    await unwrapDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: charge.id,
      purchaseId: onlinePurchase.id,
      amount: 25,
    });
    const coverage = await unwrapDb(ctx.db).execute(sql`
      SELECT ${financialTransactionCoverageSql("t")}->>'expectation' AS expectation
      FROM "FinancialTransaction" t WHERE t.id = ${charge.id}
    `);
    expect(coverage.rows[0]?.expectation).toBe("required");
  });

  it("never reports a derived value as an order evidence conflict", async () => {
    const derived = await vendorWith("not_expected");
    const conflicting = await vendorWith("not_expected", "required");
    const qualities = await readDataQualities(ctx.db, "vendor", [
      derived.id,
      conflicting.id,
    ]);
    const checks = (id: typeof derived.id) =>
      qualities.get(id)?.gaps.map((gap) => gap.check);
    expect(checks(derived.id)).not.toContain("vendor_order_evidence_conflict");
    expect(checks(conflicting.id)).toContain("vendor_order_evidence_conflict");
  });
});

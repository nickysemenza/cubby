import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  storedImportFix,
  type ImportWriterInput,
} from "@cubby/schemas/purchase-import";
import { and, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { expenseCostDollarsSql } from "~/server/db/computed/expense-aggregate-sql";
import { getDb, notDeleted } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  expense,
  financialTransaction,
  financialTransactionAllocation,
  inventoryEntry,
  product,
  purchase,
  sourceOrderObservation,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import {
  commitFinancialBooking,
  previewFinancialBooking,
} from "~/server/domains/financial-transaction/repo/financial-booking";
import { createPurchaseEventRecord } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { deleteProducts } from "~/server/domains/product/repo/crud";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import { getProductMovementTimeline } from "~/server/domains/product/repo/movement-timeline";
import { loadProductPricing } from "~/server/domains/product/repo/pricing";
import { loadProductIdentifierClaims } from "~/server/domains/product/repo/product-identity-claims";
import { purchaseCoverageSql } from "~/server/domains/purchase/repo/purchase-evidence-policy";
import {
  listPurchaseProducts,
  listProductPurchases,
  detachPurchaseProducts,
} from "~/server/domains/purchase/repo/purchase-products";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { findOrphanedProducts } from "~/server/generic/problems/repo/detectors-product";
import {
  createProductIdentityFixture,
  makeProductInput,
  dollarExpenseColumns,
} from "~/server/testing/repo.fixtures";
import { runFinding } from "~/server/testing/run-finding.fixtures";

import {
  memberImport,
  memberImportWorld,
  type MemberImportOrder,
} from "../operations/order-import.fixtures";
import { acceptedOrders, acceptedOrderLinesSql } from "./accepted-order-read";
import { resolveRunFinding } from "./findings";
import { prepareSourceOrderReconciliation } from "./reconciliation";
import { commitAcceptedSourceOrderReconciliation } from "./reconciliation-accepted";

// Missing money/date must not suppress supported Product identity or manufacture
// financial/stock rows; replay, an existing identity, and a competing identity
// must retain their source binding. A Product merge
// must preserve the original variant; removing an editable Purchase link must
// neither orphan nor permit deleting a Product still named by original evidence.
// A printed calendar day must not shift through UTC parsing; a true instant uses
// the household day, and a missing day cannot be supplied by the import time.
describe("incomplete itemized purchase identity", () => {
  const ctx = withTestDb();
  async function scope() {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: { name: "Example variant maker" },
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "file_import",
      trigger: "manual",
      status: "running",
    });
    const input: ImportWriterInput = {
      runId,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      defaultTrade: "other",
      source: {
        kind: "mail_message",
        externalKey: "gmail:example-mailbox:incomplete-itemized",
        checksum: "a".repeat(64),
      },
      extraction: {
        status: "ready",
        candidate: {
          orderId: "EXAMPLE-INCOMPLETE",
          orderedAt: null,
          merchant: "Example variant maker",
          currency: "USD",
          printedGrandTotal: null,
          lines: [
            {
              title: "Q-17 blue small device",
              amount: 24,
              lineKind: "principal",
              sku: "Q17-BLUE-SMALL",
              productUrl:
                "https://maker.example.test/q17?size=small&color=blue",
            },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
      productResolutions: [{ kind: "new", lineIndex: 0 }],
      primaryDocumentImageId: null,
      screenshotImageId: null,
    };
    return { party, vendor, input };
  }

  // A total-only confirmation: one aggregate carries the money, its items stay
  // unpriced with their Products, and an order-number Purchase that waited
  // for its details is the one itemized.
  it("books a printed total beside unpriced items on the order's existing Purchase without review", async () => {
    const { input, vendor } = await scope();
    const waiting = await createPurchaseEventRecord(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "EXAMPLE-TOTAL-ONLY",
      date: "2032-03-04",
    });
    input.extraction = {
      status: "needs_review",
      reason: "unpriced_itemization",
      detail: "The confirmation prints its total but no item prices.",
      candidate: {
        ...input.extraction.candidate!,
        orderId: "EXAMPLE-TOTAL-ONLY",
        orderedAt: "2032-03-01",
        printedGrandTotal: 5.52,
        lines: [
          {
            title: "Synthetic soap",
            amount: null,
            quantity: 1,
            lineKind: "principal",
          },
        ],
      },
    };
    const order: MemberImportOrder = {
      stableOrderId: "total-only",
      vendorId: vendor.shortcode,
      source: {
        kind: "vendor_export",
        externalKey: "synthetic:total-only",
        checksum: input.source.checksum,
      },
      extraction: input.extraction,
      resolutions: [{ kind: "new" }],
    };
    const first = (
      await memberImport(ctx.db, ctx.actor, {
        key: "total-only-first",
        orders: [order],
        defaultTrade: "other",
      })
    ).committed.items[0];
    expect(first).toMatchObject({
      outcome: "updated",
      purchaseId: waiting.shortcode,
      findingCount: 0,
    });
    const rows = await getDb(ctx.db)
      .select(dollarExpenseColumns())
      .from(expense)
      .where(and(eq(expense.purchaseId, waiting.id), notDeleted(expense)));
    expect(
      rows.map(({ cost, lineBasis, name }) => ({ cost, lineBasis, name })),
    ).toEqual(
      expect.arrayContaining([
        { cost: 5.52, lineBasis: "allocation", name: "Example variant maker" },
        { cost: null, lineBasis: "item_line", name: "Synthetic soap" },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.cost === null)?.productId).not.toBeNull();
    const [coverage] = await getDb(ctx.db)
      .select({ value: purchaseCoverageSql("Purchase") })
      .from(purchase)
      .where(eq(purchase.id, waiting.id));
    expect(coverage?.value).toMatchObject({ booking: "recorded" });
    expect(
      (
        await memberImport(ctx.db, ctx.actor, {
          key: "total-only-recapture",
          orders: [order],
          defaultTrade: "other",
        })
      ).committed.items[0],
    ).toMatchObject({ outcome: "replayed", purchaseId: waiting.shortcode });
    // The card charge settles against the printed total; unpriced items never block it.
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic total-only member",
      kind: "member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic total-only cash",
      identity: { kind: "cash" },
      ledgerPartyId: owner.output.id,
    });
    const charge = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 5.52,
      postedDate: "2032-03-02",
      merchant: vendor.name,
    });
    const preview = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({
        transactionId: charge.output.id,
        purchaseId: waiting.shortcode,
      }),
    );
    await commitFinancialBooking(ctx.db, preview, ctx.actor);
    const allocations = await getDb(ctx.db)
      .select({ purchaseId: financialTransactionAllocation.purchaseId })
      .from(financialTransactionAllocation)
      .innerJoin(
        financialTransaction,
        eq(
          financialTransaction.id,
          financialTransactionAllocation.transactionId,
        ),
      )
      .where(eq(financialTransaction.shortcode, charge.output.id));
    expect(allocations).toEqual([{ purchaseId: waiting.id }]);
  });

  // Money already on the order that is not its printed total (a partial
  // charge booked on a notice Purchase) never makes the items "carried".
  it("reviews a total-only confirmation whose Purchase already holds a different amount", async () => {
    const { input, vendor } = await scope();
    const waiting = await createPurchaseEventRecord(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "EXAMPLE-PARTIAL",
      date: "2032-03-04",
    });
    await createPurchaseEventRecord(ctx.db, "expense", {
      purchaseId: waiting.id,
      name: "Synthetic partial charge",
      cost: 300n,
      date: "2032-03-04",
      costType: "materials",
      lineKind: "principal",
      lineBasis: "allocation",
    });
    input.extraction = {
      status: "needs_review",
      reason: "unpriced_itemization",
      detail: "The confirmation prints its total but no item prices.",
      candidate: {
        ...input.extraction.candidate!,
        orderId: "EXAMPLE-PARTIAL",
        orderedAt: "2032-03-01",
        printedGrandTotal: 5.52,
        lines: [
          {
            title: "Synthetic soap",
            amount: null,
            quantity: 1,
            lineKind: "principal",
          },
        ],
      },
    };
    const result = (
      await memberImport(ctx.db, ctx.actor, {
        key: "partial-total",
        defaultTrade: "other",
        orders: [
          {
            stableOrderId: "partial-total",
            vendorId: vendor.shortcode,
            source: {
              kind: "vendor_export",
              externalKey: "synthetic:partial-total",
              checksum: input.source.checksum,
            },
            extraction: input.extraction,
            resolutions: [{ kind: "new" }],
          },
        ],
      })
    ).committed.items[0];
    expect(result).toMatchObject({
      outcome: "conflict",
      purchaseId: waiting.shortcode,
      findingCount: 1,
    });
    const rows = await getDb(ctx.db)
      .select({ cost: expenseCostDollarsSql(), name: expense.name })
      .from(expense)
      .where(and(eq(expense.purchaseId, waiting.id), notDeleted(expense)));
    expect(rows).toEqual([{ cost: 3, name: "Synthetic partial charge" }]);
  });

  it.each(["same source", "separate source"] as const)(
    "retains foreign items as unpriced Expenses beside one USD aggregate through replay and equivalent evidence (%s)",
    async (sourceIdentity) => {
      const { input, vendor } = await scope();
      const item = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic wine" }),
        ctx.actor,
      );
      input.source = {
        kind: "vendor_export",
        externalKey: "synthetic:foreign-order",
        checksum: "b".repeat(64),
      };
      const candidate = input.extraction.candidate!;
      candidate.currency = "EUR";
      candidate.orderedAt = "2032-02-29";
      candidate.printedGrandTotal = 53;
      candidate.lines = [
        {
          title: "Synthetic wine",
          amount: 24,
          quantity: 2,
          lineKind: "principal",
        },
        {
          title: "Synthetic wine",
          amount: 24,
          quantity: 2,
          lineKind: "principal",
        },
        { title: "Synthetic sample", amount: 0, lineKind: "principal" },
        { title: "Shipping", amount: 5, lineKind: "shipping" },
      ];
      const foreignOrder: MemberImportOrder = {
        stableOrderId: "foreign-items",
        vendorId: vendor.shortcode,
        source: { ...input.source, kind: "vendor_export" },
        extraction: input.extraction,
        resolutions: [0, 1, 2].map(() => ({
          kind: "existing",
          productId: item.id,
        })),
      };
      const first = (
        await memberImport(ctx.db, ctx.actor, {
          key: "foreign-first",
          orders: [foreignOrder],
          defaultTrade: "other",
        })
      ).committed.items[0]!;
      if (!first.purchaseId) throw new Error("Foreign Purchase missing");
      const [savedPurchase] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.shortcode, first.purchaseId));
      if (!savedPurchase) throw new Error("Foreign Purchase row missing");
      const purchaseId = savedPurchase.id;
      const lines = () =>
        getDb(ctx.db)
          .select(dollarExpenseColumns())
          .from(expense)
          .where(and(eq(expense.purchaseId, purchaseId), notDeleted(expense)));
      const coverage = async () =>
        (
          await getDb(ctx.db)
            .select({ value: purchaseCoverageSql("Purchase") })
            .from(purchase)
            .where(eq(purchase.id, purchaseId))
        )[0]?.value;
      expect(await coverage()).toMatchObject({
        booking: "partial",
        itemization: "present",
      });
      const insertedLines = await lines();
      const bindings = await getDb(ctx.db)
        .select({
          expenseId: sql<string>`accepted."expenseId"`,
          lineIndex: sql<number>`accepted."lineIndex"`,
        })
        .from(sql`${acceptedOrderLinesSql} accepted`)
        .where(
          sql`accepted."purchaseId"=${purchaseId} AND accepted.extraction#>>'{candidate,currency}'='EUR'`,
        )
        .orderBy(sql`accepted."lineIndex"`);
      const original = bindings.map((binding) => {
        const row = insertedLines.find((line) => line.id === binding.expenseId);
        if (!row) throw new Error("Synthetic foreign line binding is missing");
        return row;
      });
      const reviewedItem = original[0]!;
      expect(original).toHaveLength(4);
      expect(original.map((row) => row.cost)).toEqual([null, null, null, null]);
      expect(
        original
          .filter((row) => row.productId === item.entityId)
          .map((row) => row.productQuantity)
          .sort((a, b) => (a ?? -1) - (b ?? -1)),
      ).toEqual([null, 2, 2]);
      const [order] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, purchaseId));
      if (!order) throw new Error("Foreign Purchase row missing");
      const account = await insertWithShortcode(ctx.db, "financialAccount", {
        name: "Synthetic USD card",
        identity: { kind: "credit_card", network: "visa" },
        ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
      });
      const charge = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.shortcode,
        kind: "purchase",
        status: "posted",
        amount: 61,
        postedDate: "2032-02-28",
        merchant: vendor.name,
      });
      const preview = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: charge.output.id,
          purchaseId: order.shortcode,
        }),
      );
      await commitFinancialBooking(ctx.db, preview, ctx.actor);
      const [aggregate] = (await lines()).filter(
        (row) => row.lineBasis === "allocation",
      );
      if (!aggregate) throw new Error("Synthetic settled aggregate missing");
      const statementBefore = await getDb(ctx.db)
        .select()
        .from(financialTransaction);
      const settlementBefore = await getDb(ctx.db)
        .select()
        .from(financialTransactionAllocation);
      expect(await coverage()).toMatchObject({
        booking: "recorded",
        itemization: "present",
      });
      await expect(
        updateExpense(
          ctx.db,
          parseShortcodeFor("expense", reviewedItem.shortcode),
          { cost: 28 },
          ctx.actor,
        ),
      ).rejects.toThrow(/reviewed source reconciliation/);
      await updateExpense(
        ctx.db,
        parseShortcodeFor("expense", reviewedItem.shortcode),
        { lineKind: "fee", productId: null },
        ctx.actor,
      );
      await expect(
        updateExpense(
          ctx.db,
          parseShortcodeFor("expense", reviewedItem.shortcode),
          { cost: 10 },
          ctx.actor,
        ),
      ).rejects.toThrow(/reviewed source reconciliation/);
      const otherOrder = await createPurchaseEventRecord(ctx.db, "purchase", {
        vendorId: order.vendorId,
        date: "2032-03-01",
      });
      await updateExpense(
        ctx.db,
        parseShortcodeFor("expense", reviewedItem.shortcode),
        { purchaseId: parseShortcodeFor("purchase", otherOrder.shortcode) },
        ctx.actor,
      );
      await expect(
        updateExpense(
          ctx.db,
          parseShortcodeFor("expense", reviewedItem.shortcode),
          { cost: 10 },
          ctx.actor,
        ),
      ).rejects.toThrow(/reviewed source reconciliation/);
      await updateExpense(
        ctx.db,
        parseShortcodeFor("expense", reviewedItem.shortcode),
        {
          purchaseId: parseShortcodeFor("purchase", order.shortcode),
          lineKind: "principal",
          productId: item.id,
          productQuantity: 2,
        },
        ctx.actor,
      );
      const history = await getProductMovementTimeline(ctx.db, {
        filters: {},
        ids: [item.id],
        order: "asc",
        pagination: { pageIndex: 0, pageSize: 20 },
      });
      expect(history.groups.flatMap((group) => group.movements)).toHaveLength(
        3,
      );
      expect(
        history.groups
          .flatMap((group) => group.movements)
          .every((row) => row.cost === null && row.expenseId !== null),
      ).toBe(true);
      const beforeReplay = await lines();
      const replay = (
        await memberImport(ctx.db, ctx.actor, {
          key: "foreign-replay",
          orders: [foreignOrder],
          defaultTrade: "other",
        })
      ).committed.items[0];
      expect({
        outcome: replay?.outcome,
        findingCount: replay?.findingCount,
      }).toEqual({ outcome: "replayed", findingCount: 0 });
      const equivalent = (
        await memberImport(ctx.db, ctx.actor, {
          key: "foreign-equivalent",
          orders: [
            {
              ...foreignOrder,
              source: {
                kind: "vendor_export",
                externalKey: "synthetic:foreign-dispatch",
                checksum: "c".repeat(64),
              },
            },
          ],
          defaultTrade: "other",
        })
      ).committed.items[0]!;
      expect(equivalent.purchaseId).toBe(first.purchaseId);
      expect(await lines()).toEqual(beforeReplay);
      expect(
        (await lines()).reduce((sum, row) => sum + (row.cost ?? 0), 0),
      ).toBe(61);
      expect(
        (
          await loadProductPricing(ctx.db, [{ id: item.entityId, price: null }])
        ).get(item.entityId),
      ).toMatchObject({ knownUnitCount: 0, derivedPrice: null });
      const [accepted] = await getDb(ctx.db)
        .select()
        .from(acceptedOrders)
        .where(eq(acceptedOrders.purchaseId, purchaseId));
      expect(accepted?.extraction.candidate).toMatchObject({
        currency: "EUR",
        printedGrandTotal: 53,
        lines: candidate.lines,
      });
      const corrected = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic corrected wine" }),
        ctx.actor,
      );
      await updateExpense(
        ctx.db,
        parseShortcodeFor("expense", original[0]!.shortcode),
        { productId: corrected.id },
        ctx.actor,
      );
      await memberImport(ctx.db, ctx.actor, {
        key: "foreign-corrected-replay",
        orders: [foreignOrder],
        defaultTrade: "other",
      });
      expect(
        (await lines()).find((row) => row.id === original[0]!.id)?.productId,
      ).toBe(corrected.entityId);
      expect(
        (await lines()).find((row) => row.shortcode === aggregate.shortcode)
          ?.cost,
      ).toBe(61);
      if (!accepted) throw new Error("Foreign accepted source missing");
      await updateExpense(
        ctx.db,
        parseShortcodeFor("expense", original[2]!.shortcode),
        { productId: null },
        ctx.actor,
      );
      const attachment = {
        kind: "attach_only" as const,
        lines: original.map((row, lineIndex) => ({
          lineIndex,
          expenseId: parseShortcodeFor("expense", row.shortcode),
          productId:
            lineIndex === 0 ? corrected.id : lineIndex < 3 ? item.id : null,
        })),
      };
      const attached = await prepareSourceOrderReconciliation(
        ctx.db,
        { sourceOrderId: accepted.id, resolution: attachment },
        ctx.actor,
      );
      expect(attached.spend).toEqual({ before: 61, after: 61, delta: 0 });
      await commitAcceptedSourceOrderReconciliation(
        ctx.db,
        { sourceOrderId: accepted.id, resolution: attachment },
        ctx.actor,
      );
      expect(
        (await lines()).find((row) => row.id === original[2]!.id),
      ).toMatchObject({
        productId: item.entityId,
        productQuantity: null,
        cost: null,
      });
      await updateExpense(
        ctx.db,
        parseShortcodeFor("expense", original[0]!.shortcode),
        { productId: null },
        ctx.actor,
      );
      expect(
        (await lines()).find((row) => row.id === original[0]!.id)
          ?.productQuantity,
      ).toBeNull();
      expect(await coverage()).toMatchObject({
        booking: "recorded",
        itemization: "present",
      });
      expect((await coverage())?.products).not.toBe("present");
      expect((await coverage())?.products).not.toBe("not_expected");
      const usd = structuredClone(input);
      usd.source = {
        kind: "vendor_export",
        externalKey:
          sourceIdentity === "same source"
            ? input.source.externalKey
            : "synthetic:actual-usd-receipt",
        checksum: "d".repeat(64),
      };
      usd.extraction.candidate!.currency = "USD";
      usd.extraction.candidate!.printedGrandTotal = 61;
      usd.extraction.candidate!.lines[0]!.amount = 28;
      delete usd.extraction.candidate!.lines[0]!.quantity;
      usd.extraction.candidate!.lines[1]!.amount = 28;
      usd.extraction.candidate!.lines[2]!.quantity = 3;
      const usdOrder: MemberImportOrder = {
        ...foreignOrder,
        source: { ...usd.source, kind: "vendor_export" },
        extraction: usd.extraction,
      };
      await memberImport(ctx.db, ctx.actor, {
        key: "foreign-usd-review",
        orders: [usdOrder],
        defaultTrade: "other",
      });
      const findings = await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.entityId, purchaseId));
      const finding = findings.find(
        (row) =>
          storedImportFix.parse(row.proposedFix)?.kind ===
          "reconcile_source_order",
      );
      if (!finding) throw new Error("USD itemization review missing");
      const resolution = {
        kind: "replace_lines" as const,
        expenseIds: [
          ...original.map((row) => parseShortcodeFor("expense", row.shortcode)),
          parseShortcodeFor("expense", aggregate.shortcode),
        ],
        lines: candidate.lines.map((_, lineIndex) => {
          const row = original[lineIndex]!;
          return {
            lineIndex,
            expenseId: parseShortcodeFor("expense", row.shortcode),
            productId:
              lineIndex === 0 ? corrected.id : lineIndex < 3 ? item.id : null,
          };
        }),
      };
      await expect(
        prepareSourceOrderReconciliation(
          ctx.db,
          {
            id: finding.id,
            resolution: {
              ...resolution,
              expenseIds: [],
              lines: resolution.lines.map((line) => ({
                ...line,
                expenseId: null,
              })),
            },
          },
          ctx.actor,
        ),
      ).rejects.toThrow(/foreign item roster/);
      const review = await prepareSourceOrderReconciliation(
        ctx.db,
        { id: finding.id, resolution },
        ctx.actor,
      );
      expect(review.spend).toEqual({ before: 61, after: 61, delta: 0 });
      await resolveRunFinding(
        ctx.db,
        {
          id: finding.id,
          action: "apply",
          reviewedFingerprint: review.reviewedFingerprint,
        },
        ctx.actor,
      );
      const originalReferences = await getDb(ctx.db)
        .select({
          expenseId: sql<string>`accepted."expenseId"`,
          lineIndex: sql<number>`accepted."lineIndex"`,
        })
        .from(sql`${acceptedOrderLinesSql} accepted`)
        .where(sql`accepted."sourceOrderId"=${accepted.id}`)
        .orderBy(sql`accepted."lineIndex"`);
      expect(originalReferences.map((row) => row.expenseId)).toEqual(
        original.map((row) => row.id),
      );
      const [originalSource] = await getDb(ctx.db)
        .select()
        .from(sourceOrderObservation)
        .where(eq(sourceOrderObservation.id, accepted.id));
      expect(originalSource?.extraction).toEqual(accepted.extraction);
      expect(originalSource?.checksum).toBe(accepted.checksum);
      expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual(
        statementBefore,
      );
      expect(
        await getDb(ctx.db).select().from(financialTransactionAllocation),
      ).toEqual(settlementBefore);
      const [preservedOrder] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, purchaseId));
      expect(preservedOrder?.date).toBe("2032-02-29");
      const priced = await lines();
      expect(priced.map((row) => row.id).sort()).toEqual(
        original.map((row) => row.id).sort(),
      );
      expect(priced.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBe(61);
      expect(
        priced.find((row) => row.id === original[0]!.id)?.productQuantity,
      ).toBe(2);
      expect(
        priced.find((row) => row.id === original[2]!.id)?.productQuantity,
      ).toBe(3);
      expect(
        (
          await loadProductPricing(ctx.db, [
            { id: corrected.entityId, price: null },
          ])
        ).get(corrected.entityId),
      ).toMatchObject({ knownUnitCount: 2, derivedPrice: 14 });
      expect(await coverage()).toMatchObject({
        booking: "recorded",
        itemization: "present",
      });
      await mergeProducts(
        ctx.db,
        { keepId: item.id, mergeIds: [corrected.id] },
        ctx.actor,
      );
      await memberImport(ctx.db, ctx.actor, {
        key: "foreign-merged-replay",
        orders: [foreignOrder],
        defaultTrade: "other",
      });
      await memberImport(ctx.db, ctx.actor, {
        key: "foreign-usd-merged-replay",
        orders: [usdOrder],
        defaultTrade: "other",
      });
      expect((await lines()).map((row) => row.id).sort()).toEqual(
        original.map((row) => row.id).sort(),
      );
      const mergedHistory = await getProductMovementTimeline(ctx.db, {
        filters: {},
        ids: [item.id],
        order: "asc",
        pagination: { pageIndex: 0, pageSize: 20 },
      });
      expect(
        mergedHistory.groups.flatMap((group) => group.movements),
      ).toHaveLength(3);
      expect(
        (
          await loadProductPricing(ctx.db, [{ id: item.entityId, price: null }])
        ).get(item.entityId),
      ).toMatchObject({ knownUnitCount: 4, derivedPrice: 14 });
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    },
  );

  it.each([
    { orderedAt: "2032-02-29", expectedDate: "2032-02-29" },
    {
      orderedAt: "2033-07-11T04:32:43.000Z",
      expectedDate: "2033-07-10",
    },
    {
      orderedAt: "2033-07-11T13:32:43+09:00",
      expectedDate: "2033-07-10",
    },
    { orderedAt: null, expectedDate: null },
  ])(
    "preserves a source order day through itemized writing and stock-neutral replay ($orderedAt)",
    async ({ orderedAt, expectedDate }) => {
      const { input, vendor } = await scope();
      const candidate = input.extraction.candidate!;
      candidate.orderedAt = orderedAt;
      candidate.printedGrandTotal = 24;
      candidate.lines[0]!.quantity = 2;
      candidate.allShipmentsDelivered = true;

      const order: MemberImportOrder = {
        stableOrderId: "dated-order",
        vendorId: vendor.shortcode,
        source: {
          kind: "vendor_export",
          externalKey: "synthetic:dated-order",
          checksum: input.source.checksum,
        },
        extraction: input.extraction,
        resolutions: [{ kind: "new" }],
      };
      const first = (
        await memberImport(ctx.db, ctx.actor, {
          key: "dated-order-first",
          orders: [order],
          defaultTrade: "other",
        })
      ).committed.items[0];
      if (!first?.purchaseId)
        throw new Error("Synthetic dated Purchase missing");
      const [saved] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.shortcode, first.purchaseId));
      if (!saved) throw new Error("Synthetic dated Purchase was not retained");
      const purchaseId = saved.id;
      expect(
        (await loadProductIdentifierClaims(ctx.db)).map(
          (claim) => claim.productId,
        ),
      ).toEqual([(await getDb(ctx.db).select().from(product))[0]!.id]);
      expect(saved).toMatchObject({ date: expectedDate, statedTotal: 2400n });
      const items = await getDb(ctx.db).select().from(product);
      expect(items).toHaveLength(1);
      const lines = await getDb(ctx.db)
        .select(dollarExpenseColumns())
        .from(expense)
        .where(eq(expense.purchaseId, purchaseId));
      expect(
        lines.map(({ date, cost, lineKind, productId, productQuantity }) => ({
          date,
          cost,
          lineKind,
          productId,
          productQuantity,
        })),
      ).toEqual(
        expectedDate === null
          ? []
          : [
              {
                date: expectedDate,
                cost: 24,
                lineKind: "principal",
                productId: items[0]!.id,
                productQuantity: 2,
              },
            ],
      );
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);

      expect(
        (
          await memberImport(ctx.db, ctx.actor, {
            key: "dated-order-recapture",
            orders: [order],
            defaultTrade: "other",
          })
        ).committed.items[0],
      ).toMatchObject({ outcome: "replayed", purchaseId: first.purchaseId });
      expect(await getDb(ctx.db).select().from(product)).toEqual(items);
      expect(
        await getDb(ctx.db)
          .select(dollarExpenseColumns())
          .from(expense)
          .where(eq(expense.purchaseId, purchaseId)),
      ).toEqual(lines);
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    },
  );

  it.each(["new", "existing"] as const)(
    "retains a supported %s Product and original ordered context without an Expense",
    async (kind) => {
      const { input, vendor } = await scope();
      const existing =
        kind === "existing"
          ? await insertWithShortcode(ctx.db, "product", {
              name: "Member label for Q-17",
              brandId: await findOrCreateVendor(ctx.db, "Example maker"),
            })
          : null;
      if (existing) {
        input.extraction.candidate!.orderedAt = "2026-09-01T18:00:00Z";
      }
      const order: MemberImportOrder = {
        stableOrderId: "incomplete-context",
        vendorId: vendor.shortcode,
        source: {
          kind: "vendor_export",
          externalKey: "synthetic:incomplete-context",
          checksum: input.source.checksum,
        },
        extraction: input.extraction,
        resolutions: [
          existing
            ? {
                kind: "existing",
                productId: parseShortcodeFor("product", existing.shortcode),
              }
            : { kind: "new" },
        ],
      };
      const first = (
        await memberImport(ctx.db, ctx.actor, {
          key: "incomplete-context-first",
          orders: [order],
          defaultTrade: "other",
        })
      ).committed.items[0];
      if (!first?.purchaseId)
        throw new Error("Synthetic incomplete Purchase missing");
      const [saved] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.shortcode, first.purchaseId));
      if (!saved)
        throw new Error("Synthetic incomplete Purchase was not retained");
      const savedPurchaseId = saved.id;
      expect(saved).toMatchObject({
        date: existing ? "2026-09-01" : null,
        statedTotal: null,
      });
      expect(
        await getDb(ctx.db)
          .select(dollarExpenseColumns())
          .from(expense)
          .where(eq(expense.purchaseId, savedPurchaseId)),
      ).toEqual([]);
      const items = await getDb(ctx.db).select().from(product);
      expect(
        (await loadProductIdentifierClaims(ctx.db)).map(
          (claim) => claim.productId,
        ),
      ).toEqual([items[0]!.id]);
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(await listPurchaseProducts(ctx.db, savedPurchaseId)).toMatchObject(
        [{ productId: item.shortcode, source: "link", movementKinds: [] }],
      );
      expect(await listProductPurchases(ctx.db, item.id)).toMatchObject([
        { purchaseId: saved!.shortcode, source: "link", movementKinds: [] },
      ]);
      expect(item.name).toBe(
        existing?.name ?? input.extraction.candidate?.lines[0]?.title,
      );
      const [capture] = await getDb(ctx.db)
        .select()
        .from(acceptedOrders)
        .where(eq(acceptedOrders.purchaseId, savedPurchaseId));
      expect({
        checksum: capture?.checksum,
        extraction: capture?.extraction,
      }).toEqual({
        checksum: input.source.checksum,
        extraction: input.extraction,
      });
      expect(capture?.productBindings).toMatchObject([
        { lineIndex: 0, productId: item.id },
      ]);
      const originalCaptures = await getDb(ctx.db)
        .select()
        .from(sourceOrderObservation);
      expect(
        (
          await memberImport(ctx.db, ctx.actor, {
            key: "incomplete-context-recapture",
            orders: [order],
            defaultTrade: "other",
          })
        ).committed.items[0],
      ).toMatchObject({ outcome: "replayed", purchaseId: first.purchaseId });
      expect(await getDb(ctx.db).select().from(sourceOrderObservation)).toEqual(
        originalCaptures,
      );
      expect(await getDb(ctx.db).select().from(product)).toHaveLength(1);
      expect(
        await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
      ).toEqual([]);
    },
  );

  it("keeps a competing item identity unresolved without fabricating a Product or financial line", async () => {
    const { input, vendor } = await scope();
    const order: MemberImportOrder = {
      stableOrderId: "unresolved-identity",
      vendorId: vendor.shortcode,
      source: {
        kind: "vendor_export",
        externalKey: "synthetic:unresolved-identity",
        checksum: input.source.checksum,
      },
      extraction: input.extraction,
      resolutions: [
        {
          kind: "unresolved",
          reason:
            "Two retained variants conflict; no exact selection is supported.",
        },
      ],
    };
    const result = await memberImport(ctx.db, ctx.actor, {
      key: "unresolved-first",
      orders: [order],
      defaultTrade: "other",
    });
    const imported = result.committed.items[0];
    if (!imported?.purchaseId)
      throw new Error("Synthetic unresolved Purchase missing");
    const [saved] = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(eq(purchase.shortcode, imported.purchaseId));
    if (!saved)
      throw new Error("Synthetic unresolved Purchase was not retained");
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
    expect(
      await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
    ).toEqual([]);
    const findings = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, saved.id));
    expect(findings).toMatchObject([{ kind: "product_unresolved" }]);
    const [capture] = await getDb(ctx.db)
      .select()
      .from(acceptedOrders)
      .where(eq(acceptedOrders.purchaseId, saved.id));
    expect({
      checksum: capture?.checksum,
      extraction: capture?.extraction,
    }).toEqual({
      checksum: input.source.checksum,
      extraction: input.extraction,
    });
    expect(
      capture?.productBindings.every((binding) => binding.productId === null),
    ).toBe(true);
    const originalCaptures = await getDb(ctx.db)
      .select()
      .from(sourceOrderObservation);
    expect(await result.commit()).toEqual(result.committed);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.entityId, saved.id)),
    ).toEqual(findings);
    expect(await getDb(ctx.db).select().from(sourceOrderObservation)).toEqual(
      originalCaptures,
    );
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("preserves the original ordered variant when the Product merges", async () => {
    const { input, vendor } = await scope();
    const order: MemberImportOrder = {
      stableOrderId: "ordered-variant",
      vendorId: vendor.shortcode,
      source: {
        kind: "vendor_export",
        externalKey: "synthetic:ordered-variant",
        checksum: input.source.checksum,
      },
      extraction: input.extraction,
      resolutions: [{ kind: "new" }],
    };
    const imported = (
      await memberImport(ctx.db, ctx.actor, {
        key: "ordered-variant-first",
        orders: [order],
        defaultTrade: "other",
      })
    ).committed.items[0];
    if (!imported?.purchaseId) throw new Error("Synthetic Purchase missing");
    const [saved] = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(eq(purchase.shortcode, imported.purchaseId));
    if (!saved) throw new Error("Synthetic Purchase was not retained");
    const originalCaptures = await getDb(ctx.db)
      .select()
      .from(sourceOrderObservation);
    const savedPurchaseId = saved.id;
    const [orderedProduct] = await getDb(ctx.db).select().from(product);
    if (!orderedProduct) throw new Error("Synthetic ordered Product missing");
    const keeper = await insertWithShortcode(ctx.db, "product", {
      name: "Member's current device label",
      brandId: await findOrCreateVendor(ctx.db, "Example maker"),
    });
    await mergeProducts(
      ctx.db,
      {
        keepId: keeper.shortcode,
        mergeIds: [parseShortcodeFor("product", orderedProduct.shortcode)],
      },
      ctx.actor,
    );
    expect(await listProductPurchases(ctx.db, keeper.id)).toMatchObject([
      { source: "link", movementKinds: [] },
    ]);
    expect(
      await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
    ).toEqual([]);
    const [capture] = await getDb(ctx.db)
      .select()
      .from(acceptedOrders)
      .where(eq(acceptedOrders.purchaseId, savedPurchaseId));
    expect({
      checksum: capture?.checksum,
      extraction: capture?.extraction,
    }).toEqual({
      checksum: input.source.checksum,
      extraction: input.extraction,
    });
    expect(capture?.productBindings).toMatchObject([
      { lineIndex: 0, productId: orderedProduct.id },
    ]);
    expect(
      (await loadProductIdentifierClaims(ctx.db, keeper.id)).map(
        (claim) => claim.productId,
      ),
    ).toEqual([keeper.id]);
    expect(await getDb(ctx.db).select().from(sourceOrderObservation)).toEqual(
      originalCaptures,
    );
    expect(
      (
        await memberImport(ctx.db, ctx.actor, {
          key: "ordered-variant-recapture",
          orders: [order],
          defaultTrade: "other",
        })
      ).committed.items[0],
    ).toMatchObject({
      outcome: "replayed",
      purchaseId: imported.purchaseId,
    });
    expect(await getDb(ctx.db).select().from(sourceOrderObservation)).toEqual(
      originalCaptures,
    );
  });

  it("retains a Product through original line evidence when its editable Purchase link is removed", async () => {
    const { input, vendor } = await scope();
    const imported = (
      await memberImport(ctx.db, ctx.actor, {
        key: "retained-original",
        defaultTrade: "other",
        orders: [
          {
            stableOrderId: "retained-original",
            vendorId: vendor.shortcode,
            source: {
              kind: "vendor_export",
              externalKey: "synthetic:retained-original",
              checksum: input.source.checksum,
            },
            extraction: input.extraction,
            resolutions: [{ kind: "new" }],
          },
        ],
      })
    ).committed.items[0];
    if (!imported?.purchaseId) throw new Error("Synthetic Purchase missing");
    const [saved] = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(eq(purchase.shortcode, imported.purchaseId));
    if (!saved) throw new Error("Synthetic Purchase was not retained");
    const [item] = await getDb(ctx.db).select().from(product);
    if (!item) throw new Error("Synthetic Product missing");
    expect(await loadProductIdentifierClaims(ctx.db, item.id)).toHaveLength(1);
    await detachPurchaseProducts(ctx.db, saved.id, [item.id], ctx.actor);
    expect(await loadProductIdentifierClaims(ctx.db, item.id)).toEqual([]);
    expect(await findOrphanedProducts(ctx.db)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: item.shortcode })]),
    );
    await expect(deleteProducts(ctx.db, [item.id], ctx.actor)).rejects.toThrow(
      /original.*order|original.*line/i,
    );
    expect(
      await getDb(ctx.db).query.product.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(table, eq(product.id, item.id)),
        },
      }),
    ).toMatchObject({ deletedAt: null });
  });

  it("keeps expense-only shared-SKU lines stock-neutral", async () => {
    const { vendor } = await scope();
    const page = "https://shop.example.test/products/example-jar";
    const jar = (title: string) => ({
      title,
      amount: 5,
      quantity: 1,
      sku: "EXAMPLE-JAR-SMALL",
      productUrl: page,
      lineKind: "principal" as const,
    });
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "shared-variant",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "shared-variant",
          vendorId: vendor.shortcode,
          source: {
            kind: "receipt_photo",
            externalKey: "synthetic:shared-variant",
            checksum: "d".repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              orderId: "EXAMPLE-SHARED-VARIANT",
              orderedAt: "2026-09-01T18:00:00Z",
              merchant: vendor.name,
              currency: "USD",
              printedGrandTotal: 12,
              lines: [
                jar("Example small jar"),
                jar("Example jar, small size"),
                {
                  title: "Example meal preparation service",
                  amount: 2,
                  quantity: 1,
                  sku: "EXAMPLE-JAR-SMALL",
                  lineKind: "principal",
                },
              ],
              payments: [],
              allShipmentsDelivered: true,
            },
          },
          resolutions: [{ kind: "new" }, { kind: "new" }],
        },
      ],
    });
    const [saved] = await getDb(ctx.db)
      .select({ id: purchase.id, runId: purchase.runId })
      .from(purchase)
      .where(eq(purchase.shortcode, committed.items[0]!.purchaseId!));
    const lines = await getDb(ctx.db)
      .select(dollarExpenseColumns())
      .from(expense)
      .where(eq(expense.purchaseId, saved!.id));
    const service = lines.find((line) => line.name.endsWith("service"));
    const physical = lines.filter((line) => line.id !== service?.id);
    expect(service).toMatchObject({ productId: null, productQuantity: null });
    expect(physical).toHaveLength(2);
    const productId = physical[0]?.productId;
    expect(productId).not.toBeNull();
    expect(physical).toMatchObject([
      { productId, productQuantity: 1, url: page },
      { productId, productQuantity: 1, url: page },
    ]);
    expect(lines.reduce((sum, line) => sum + (line.cost ?? 0), 0)).toBe(12);
    expect(await getDb(ctx.db).select().from(product)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ kind: runFinding.kind })
        .from(runFinding)
        .where(eq(runFinding.runId, parseEntityId("run", saved!.runId!))),
    ).toEqual([]);
  });

  it.each(["date", "total"] as const)(
    "retains a supported incomplete Purchase with unknown %s without inventing money, Products, or an order identity",
    async (missing) => {
      const { vendor } = await scope();
      const order: MemberImportOrder = {
        stableOrderId: "incomplete-service",
        vendorId: vendor.shortcode,
        source: {
          kind: "receipt_photo",
          externalKey: "synthetic:incomplete-service",
          checksum: "b".repeat(64),
        },
        extraction: {
          status: "ready",
          candidate: {
            orderId: null,
            orderedAt: missing === "date" ? null : "2026-10-01T12:00:00Z",
            merchant: vendor.name,
            currency: "USD",
            printedGrandTotal: missing === "total" ? null : 10,
            lines: [
              {
                title: "Synthetic annual service",
                amount: 10,
                quantity: 1,
                lineKind: "principal",
              },
            ],
            payments: [],
            allShipmentsDelivered: true,
          },
        },
      };
      const { committed, commit } = await memberImport(ctx.db, ctx.actor, {
        key: `incomplete-${missing}`,
        orders: [order],
        defaultTrade: "other",
      });
      expect(committed.items[0]?.purchaseId).toBeTruthy();
      expect(
        await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
      ).toEqual([]);
      expect(await getDb(ctx.db).select().from(product)).toEqual([]);
      expect(
        await getDb(ctx.db).select().from(sourceOrderObservation),
      ).toHaveLength(1);
      expect(await commit()).toEqual(committed);
      expect(
        (await getDb(ctx.db).select().from(purchase))[0]?.orderId,
      ).toBeNull();
    },
  );
});

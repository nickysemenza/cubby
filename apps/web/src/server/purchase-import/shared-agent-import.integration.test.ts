import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  type ExtractedOrderCandidate,
  commitPurchaseImportInput,
  proposedImportFix,
} from "@cubby/schemas/purchase-import";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityExternalId,
  entitySource,
  externalSource,
  auditLog,
  expense,
  financialTransactionAllocation,
  importSourceClaim,
  sourceOrderObservation,
  importSourceProduct,
  inventoryEntry,
  product,
  purchase,
  runFinding,
  runOperation,
  vendor as vendorTable,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { resolveRunFinding } from "./findings";
import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startImportRunFixture } from "./import-run.fixtures";
import {
  mailSource,
  memberImport,
  prepareMemberImport,
  retainedMailFixture,
  type MemberImportOrder,
} from "./order-import.fixtures";
import { prepareSourceOrderReconciliation } from "./reconciliation";

const checksum = (digit: string) => digit.repeat(64);

describe("shared purchase-import prepare and commit", () => {
  const ctx = withTestDb();

  it("reuses an exact ASIN and replays the committed business result", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Shared import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Shared import Amazon fixture",
      website: "https://www.amazon.com/orders",
      browserDomains: ["amazon.com", "www.amazon.com"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Shared import fixture account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Reusable exact-ASIN product" }),
      ctx.actor,
    );
    const [existingProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!existingProductRow) throw new Error("Product fixture was not created");
    await withTransaction(ctx.db, async (tx) => {
      await ensureExternalSources(tx, ["gtin"]);
      await tx.insert(externalSource).values({
        slug: "amazon",
        label: "Example registered catalog",
        vendorId: vendor.id,
      });
      await tx.insert(entityExternalId).values({
        entityId: existingProduct.entityId,
        entityKind: "product" as const,
        source: "amazon",
        kind: "asin",
        externalId: "B012345678",
        isPrimary: true,
      });
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const financialAccount = await insertWithShortcode(
      ctx.db,
      "financialAccount",
      {
        name: "Shared import fixture card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: party.id,
      },
    );
    const postedCharge = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: financialAccount.id,
        kind: "purchase",
        status: "posted",
        amount: 12.34,
        transactionDate: null,
        postedDate: "2026-09-21",
      },
    );
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:amazon-order-1",
        itemOperationIds: ["prepare-item:amazon-order-1"],
      },
      orders: [
        {
          stableOrderId: "amazon-order-1",
          itemOperationId: "prepare-item:amazon-order-1",
          source: {
            kind: "vendor_export" as const,
            externalKey: "amazon:order:111-2222222-3333333",
            checksum: checksum("a"),
          },
          evidenceChecksum: checksum("b"),
          extractionRevision: "amazon@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "111-2222222-3333333",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Amazon",
              currency: "USD",
              printedGrandTotal: 12.34,
              lines: [
                {
                  title: "Reusable exact-ASIN product",
                  amount: 12.34,
                  lineKind: "principal" as const,
                  productUrl:
                    "https://www.amazon.com/dp/B012345678?ref_=orders",
                },
              ],
              payments: [
                { amount: 12.34, chargedAt: "2026-09-20T12:00:00.000Z" },
              ],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["amazon-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };

    const prepared = await preparePurchaseImport(
      ctx.db,
      prepareInput,
      ctx.actor,
    );
    expect(prepared.status).toBe("running");
    expect(prepared.orders[0]?.lines[0]?.candidates[0]).toMatchObject({
      productId: existingProductRow.shortcode,
      exactIdentifierMatch: true,
    });

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: {
        runId: run.id,
        operationId: "commit:amazon-order-1",
      },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: "amazon-order-1",
          stableLineId: "amazon-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: existingProductRow.shortcode,
          },
        },
      ],
    });
    const first = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    const replay = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(replay).toEqual(first);

    const writtenPurchases = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "111-2222222-3333333"));
    expect(writtenPurchases).toHaveLength(1);
    const writtenExpenses = await getDb(ctx.db)
      .select({ productId: expense.productId })
      .from(expense)
      .where(eq(expense.purchaseId, writtenPurchases[0]!.id));
    expect(writtenExpenses).toEqual([{ productId: existingProduct.entityId }]);
    const allocations = await getDb(ctx.db)
      .select({ transactionId: financialTransactionAllocation.transactionId })
      .from(financialTransactionAllocation)
      .where(
        eq(financialTransactionAllocation.purchaseId, writtenPurchases[0]!.id),
      );
    expect(allocations).toEqual([{ transactionId: postedCharge.id }]);

    // The import's writes are recorded once, under the Run, in the shared
    // audit trail; a replay of the same commit adds nothing.
    const runAudit = await getDb(ctx.db)
      .select({
        entityKind: auditLog.entityKind,
        entityId: auditLog.entityId,
        action: auditLog.action,
        userId: auditLog.userId,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.runId, run.id),
          inArray(auditLog.entityKind, ["purchase", "expense"]),
        ),
      );
    expect(runAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: "purchase",
          entityId: writtenPurchases[0]!.id,
          userId: ctx.actor.userId,
        }),
        expect.objectContaining({ entityKind: "expense", action: "create" }),
      ]),
    );
    expect(
      runAudit.filter((row) => row.entityKind === "purchase"),
    ).toHaveLength(1);
  });

  it("matches a photo-recorded barcode exactly when the order line SKU is that UPC", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Barcode import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Barcode import vendor fixture",
      website: "https://shop.example.com/orders",
      browserDomains: ["shop.example.com"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Barcode import fixture account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    // A photo-first Product whose only identifier is the barcode read off its
    // tag, stored under the vendor-neutral GTIN source.
    const photoProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Gray crew t-shirt — M" }),
      ctx.actor,
    );
    const [photoProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, photoProduct.entityId));
    if (!photoProductRow) throw new Error("Product fixture was not created");
    await withTransaction(ctx.db, async (tx) => {
      await ensureExternalSources(tx, ["amazon", "gtin"]);
      await tx.insert(entityExternalId).values({
        entityId: photoProduct.entityId,
        entityKind: "product" as const,
        source: "gtin",
        kind: "gtin_14",
        externalId: "00012345678905",
        isPrimary: true,
      });
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });

    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          runId: run.id,
          operationId: "prepare:barcode-order-1",
          itemOperationIds: ["prepare-item:barcode-order-1"],
        },
        orders: [
          {
            stableOrderId: "barcode-order-1",
            itemOperationId: "prepare-item:barcode-order-1",
            source: {
              kind: "vendor_export" as const,
              externalKey: "example:order:barcode-1",
              checksum: checksum("c"),
            },
            evidenceChecksum: checksum("d"),
            extractionRevision: "example@fixture-1",
            extraction: {
              status: "ready" as const,
              candidate: {
                orderId: "barcode-1",
                orderedAt: "2026-09-20T12:00:00.000Z",
                merchant: "Example Shop",
                currency: "USD",
                printedGrandTotal: 20,
                lines: [
                  {
                    title: "Everyday Crew Tee Heather Gray",
                    amount: 20,
                    lineKind: "principal" as const,
                    sku: "012345678905",
                  },
                ],
                payments: [],
                allShipmentsDelivered: false,
              },
            },
            lineIds: ["barcode-order-1:line-1"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    expect(prepared.orders[0]?.lines[0]?.candidates[0]).toMatchObject({
      productId: photoProductRow.shortcode,
      exactIdentifierMatch: true,
    });
  });

  it("commits tax and shipping lines using only the principal line's resolution", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Adjustment lines member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Adjustment lines vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Adjustment lines account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Adjustment lines widget" }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!productRow) throw new Error("Product fixture was not created");

    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:adjustments-order-1",
        itemOperationIds: ["prepare-item:adjustments-order-1"],
      },
      orders: [
        {
          stableOrderId: "adjustments-order-1",
          itemOperationId: "prepare-item:adjustments-order-1",
          source: {
            kind: "vendor_export" as const,
            externalKey: "adjustments:order:1",
            checksum: checksum("e"),
          },
          evidenceChecksum: checksum("f"),
          extractionRevision: "adjustments@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "ADJUSTMENTS-ORDER-1",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 25,
              lines: [
                {
                  title: "Adjustment lines widget",
                  amount: 20,
                  lineKind: "principal" as const,
                },
                { title: "Sales tax", amount: 2, lineKind: "tax" as const },
                {
                  title: "Shipping",
                  amount: 3,
                  lineKind: "shipping" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: [
            "adjustments-order-1:line-1",
            "adjustments-order-1:line-2",
            "adjustments-order-1:line-3",
          ],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    // Only the principal line carries a resolution — tax and shipping are
    // never resolvable to a Product, matching what the MCP layer sends.
    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: {
        runId: run.id,
        operationId: "commit:adjustments-order-1",
      },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "adjustments-order-1",
          stableLineId: "adjustments-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: parseShortcodeFor("product", productRow.shortcode),
          },
        },
      ],
    });

    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(result.status).toBe("running");
    expect(result.items[0]?.purchaseId).not.toBeNull();

    const [written] = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "ADJUSTMENTS-ORDER-1"));
    if (!written) throw new Error("Purchase was not written");
    const writtenExpenses = await getDb(ctx.db)
      .select({ lineKind: expense.lineKind, productId: expense.productId })
      .from(expense)
      .where(eq(expense.purchaseId, written.id));
    expect(writtenExpenses).toHaveLength(3);
    expect(
      writtenExpenses.find((row) => row.lineKind === "principal")?.productId,
    ).toBe(existingProduct.entityId);
    for (const kind of ["tax", "shipping"] as const) {
      expect(
        writtenExpenses.find((row) => row.lineKind === kind)?.productId,
      ).toBeNull();
    }
  });

  it("leaves a failed RunOperation row when a resolution's product cannot be resolved", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Failed commit member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Failed commit vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Failed commit account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:failing-order-1",
        itemOperationIds: ["prepare-item:failing-order-1"],
      },
      orders: [
        {
          stableOrderId: "failing-order-1",
          itemOperationId: "prepare-item:failing-order-1",
          source: {
            kind: "vendor_export" as const,
            externalKey: "failing:order:1",
            checksum: checksum("1"),
          },
          evidenceChecksum: checksum("2"),
          extractionRevision: "failing@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "FAILING-ORDER-1",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 9.99,
              lines: [
                {
                  title: "Widget",
                  amount: 9.99,
                  lineKind: "principal" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["failing-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const operationId = "commit:failing-order-1";
    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "failing-order-1",
          stableLineId: "failing-order-1:line-1",
          // Well-formed shortcode for a Product that does not exist:
          // resolveOrThrow rejects deep inside the transaction, after the
          // RunOperation "started" row has already been inserted, so
          // that insert is rolled back along with everything else.
          resolution: { kind: "existing" as const, productId: "PRD-9999" },
        },
      ],
    });

    await expect(
      commitPurchaseImport(ctx.db, commitInput, ctx.actor),
    ).rejects.toThrow("PRD-9999");

    const [operation] = await getDb(ctx.db)
      .select({
        state: runOperation.state,
        error: runOperation.error,
      })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, run.id),
          eq(runOperation.operationId, operationId),
        ),
      );
    expect(operation?.state).toBe("failed");
    expect(operation?.error).toContain("PRD-9999");
  });

  /**
   * A member booked an order by hand as one aggregate Expense, then an import
   * of the same order commits its itemized line, which leaves a reviewed
   * replacement of the aggregate for approval.
   */
  async function importOverManualAggregate(
    targetOrderless: boolean,
    categorized = false,
    includeTax = false,
  ) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Manual-then-import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Manual-then-import vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Manual-then-import account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    // A household member recorded this order by hand before any import ran:
    // one aggregate Expense, no Product, no source claim.
    const manualPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: targetOrderless ? null : "MANUAL-ORDER-1",
      date: "2026-09-18",
      statedTotal: 45,
    });
    const category = categorized
      ? await insertWithShortcode(ctx.db, "spendingCategory", {
          name: "Replacement category",
        })
      : null;
    const manualExpense = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: manualPurchase.id,
      name: "Recorded from a paper receipt",
      cost: 45,
      date: "2026-09-18",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: null,
      productQuantity: null,
      spendingCategoryId: category?.id ?? null,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Manual merge target product" }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!productRow) throw new Error("Product fixture was not created");

    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:manual-order-1",
        itemOperationIds: ["prepare-item:manual-order-1"],
      },
      orders: [
        {
          stableOrderId: "manual-order-1",
          targetPurchaseId: targetOrderless
            ? manualPurchase.shortcode
            : undefined,
          itemOperationId: "prepare-item:manual-order-1",
          source: {
            kind: "vendor_export" as const,
            externalKey: "manual-then-import:order:1",
            checksum: checksum("5"),
          },
          evidenceChecksum: checksum("6"),
          extractionRevision: "manual-then-import@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "MANUAL-ORDER-1",
              orderedAt: "2026-09-18T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 45,
              lines: includeTax
                ? [
                    {
                      title: "Manual merge target product",
                      amount: 40,
                      lineKind: "principal" as const,
                    },
                    { title: "Sales tax", amount: 5, lineKind: "tax" as const },
                  ]
                : [
                    {
                      title: "Manual merge target product",
                      amount: 45,
                      lineKind: "principal" as const,
                    },
                  ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: includeTax
            ? ["manual-order-1:line-1", "manual-order-1:line-2"]
            : ["manual-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:manual-order-1" },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "manual-order-1",
          stableLineId: "manual-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: parseShortcodeFor("product", productRow.shortcode),
          },
        },
      ],
    });
    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    return {
      manualPurchase,
      manualExpense,
      existingProduct,
      productRow,
      category,
      result,
    };
  }

  async function replacementFinding(
    purchaseId: typeof purchase.$inferSelect.id,
  ) {
    const rows = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(
        and(eq(runFinding.entityId, purchaseId), eq(runFinding.status, "open")),
      );
    const finding = rows.find(
      (row) =>
        proposedImportFix.safeParse(row.proposedFix).data?.kind ===
        "reconcile_source_order",
    );
    if (!finding)
      throw new Error("Expected source-order reconciliation finding");
    return finding;
  }

  it("replaces a categorized aggregate with an uncategorized tax line", async () => {
    const { manualPurchase, manualExpense, category, productRow, result } =
      await importOverManualAggregate(false, true, true);
    if (!category) throw new Error("Expected the category fixture");
    expect(result.items[0]?.outcome).toBe("conflict");
    const finding = await replacementFinding(manualPurchase.id);
    const before = await getDb(ctx.db).select().from(expense);
    const inventoryBefore = await getDb(ctx.db).select().from(inventoryEntry);
    const review = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [manualExpense.shortcode],
          lines: [
            {
              lineIndex: 0,
              expenseId: manualExpense.shortcode,
              productId: parseShortcodeFor("product", productRow.shortcode),
            },
            {
              lineIndex: 1,
              expenseId: manualExpense.shortcode,
              productId: null,
            },
          ],
        },
      },
      ctx.actor,
    );
    expect(review.spend).toEqual({ before: 45, after: 45, delta: 0 });
    expect(await getDb(ctx.db).select().from(expense)).toEqual(before);
    await resolveRunFinding(
      ctx.db,
      {
        id: finding.id,
        action: "apply",
        reviewedFingerprint: review.reviewedFingerprint,
      },
      ctx.actor,
    );
    const rows = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, manualPurchase.id),
          isNull(expense.deletedAt),
        ),
      );
    expect(rows.find((row) => row.lineKind === "principal")).toMatchObject({
      id: manualExpense.id,
      cost: 40,
      spendingCategoryId: category.id,
    });
    expect(rows.find((row) => row.lineKind === "tax")).toMatchObject({
      cost: 5,
      spendingCategoryId: null,
    });
    expect(rows).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(
      inventoryBefore,
    );
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])(
    "keeps an exact aggregate until its unchanged replacement preview is approved (edited: %s, orderless: %s, proposal changed: %s)",
    async (editAfterPreview, targetOrderless, editProposal) => {
      const {
        manualPurchase,
        manualExpense,
        existingProduct,
        productRow,
        result,
      } = await importOverManualAggregate(targetOrderless);
      expect(result.items[0]?.outcome).toBe("conflict");
      expect(result.items[0]?.purchaseId).toBe(manualPurchase.shortcode);
      const before = await getDb(ctx.db).select().from(expense);
      expect(before).toEqual([manualExpense]);
      expect(await getDb(ctx.db).select().from(purchase)).toEqual([
        manualPurchase,
      ]);
      const stock = await getDb(ctx.db).select().from(inventoryEntry);
      const allocations = await getDb(ctx.db)
        .select()
        .from(financialTransactionAllocation);
      const finding = await replacementFinding(manualPurchase.id);
      await expect(
        resolveRunFinding(
          ctx.db,
          { id: finding.id, action: "apply" },
          ctx.actor,
        ),
      ).rejects.toThrow(/review/i);
      const review = await prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding.id,
          resolution: {
            kind: "replace_lines",
            expenseIds: [manualExpense.shortcode],
            lines: [
              {
                lineIndex: 0,
                expenseId: manualExpense.shortcode,
                productId: parseShortcodeFor("product", productRow.shortcode),
              },
            ],
          },
        },
        ctx.actor,
      );
      expect(review.spend).toEqual({ before: 45, after: 45, delta: 0 });
      expect(await getDb(ctx.db).select().from(expense)).toEqual(before);
      if (editAfterPreview)
        await getDb(ctx.db)
          .update(expense)
          .set({ notes: "Changed after preview" })
          .where(eq(expense.id, manualExpense.id));
      if (editProposal) {
        const [stored] = await getDb(ctx.db)
          .select()
          .from(runFinding)
          .where(eq(runFinding.id, finding.id));
        const fix = proposedImportFix.parse(stored!.proposedFix);
        if (
          fix.kind !== "reconcile_source_order" ||
          !fix.proposedExtraction.candidate
        )
          throw new Error("Expected reconciliation proposal");
        await getDb(ctx.db)
          .update(runFinding)
          .set({
            proposedFix: {
              ...fix,
              proposedExtraction: {
                ...fix.proposedExtraction,
                candidate: {
                  ...fix.proposedExtraction.candidate,
                  lines: fix.proposedExtraction.candidate.lines.map((line) => ({
                    ...line,
                    title: "Different unreviewed item",
                  })),
                },
              },
            },
          })
          .where(eq(runFinding.id, finding.id));
      }
      const changed = editAfterPreview || editProposal;
      const input = {
        id: finding.id,
        action: "apply" as const,
        reviewedFingerprint: review.reviewedFingerprint,
      };
      const outcome = await resolveRunFinding(ctx.db, input, ctx.actor).then(
        () => "applied",
        (error) => (error instanceof Error ? error.message : String(error)),
      );
      expect(outcome).toMatch(
        changed ? /changed|preview|stale|again/i : /^applied$/,
      );
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(stock);
      expect(
        await getDb(ctx.db).select().from(financialTransactionAllocation),
      ).toEqual(allocations);
      const live = await getDb(ctx.db)
        .select()
        .from(expense)
        .where(isNull(expense.deletedAt));
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        id: manualExpense.id,
        cost: 45,
        productId: changed ? null : existingProduct.entityId,
      });
      if (changed) return;
      expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
        status: "applied",
      });
      const after = await getDb(ctx.db)
        .select()
        .from(expense)
        .where(isNull(expense.deletedAt));
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        id: manualExpense.id,
        productId: existingProduct.entityId,
        cost: 45,
      });
      expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
      expect((await getDb(ctx.db).select().from(purchase))[0]?.orderId).toBe(
        "MANUAL-ORDER-1",
      );
      expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
        status: "applied",
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(expense)
          .where(isNull(expense.deletedAt)),
      ).toEqual(after);
      const observations = await getDb(ctx.db)
        .select()
        .from(sourceOrderObservation);
      expect(
        observations.every(
          (row) => row.extraction.candidate?.printedGrandTotal === 45,
        ),
      ).toBe(true);
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(stock);
      expect(
        await getDb(ctx.db).select().from(financialTransactionAllocation),
      ).toEqual(allocations);
    },
  );

  it.each(["accepted_identity", "competing_purchase"] as const)(
    "refuses reviewed orderless identity adoption after %s changes",
    async (change) => {
      const { manualPurchase, manualExpense, productRow } =
        await importOverManualAggregate(true);
      const finding = await replacementFinding(manualPurchase.id);
      const review = await prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding.id,
          resolution: {
            kind: "replace_lines",
            expenseIds: [manualExpense.shortcode],
            lines: [
              {
                lineIndex: 0,
                expenseId: manualExpense.shortcode,
                productId: parseShortcodeFor("product", productRow.shortcode),
              },
            ],
          },
        },
        ctx.actor,
      );
      if (change === "accepted_identity") {
        await getDb(ctx.db)
          .update(purchase)
          .set({ orderId: "DISTINCT-ACCEPTED-ORDER" })
          .where(eq(purchase.id, manualPurchase.id));
      } else {
        await insertWithShortcode(ctx.db, "purchase", {
          vendorId: manualPurchase.vendorId,
          orderId: "MANUAL-ORDER-1",
          date: "2026-09-18",
          statedTotal: 45,
        });
      }
      const before = {
        purchases: await getDb(ctx.db).select().from(purchase),
        expenses: await getDb(ctx.db).select().from(expense),
        observations: await getDb(ctx.db).select().from(sourceOrderObservation),
        stock: await getDb(ctx.db).select().from(inventoryEntry),
      };
      await expect(
        resolveRunFinding(
          ctx.db,
          {
            id: finding.id,
            action: "apply",
            reviewedFingerprint: review.reviewedFingerprint,
          },
          ctx.actor,
        ),
      ).rejects.toThrow(/changed|identity|owns|order|unique/i);
      expect(await getDb(ctx.db).select().from(purchase)).toEqual(
        before.purchases,
      );
      expect(await getDb(ctx.db).select().from(expense)).toEqual(
        before.expenses,
      );
      expect(await getDb(ctx.db).select().from(sourceOrderObservation)).toEqual(
        before.observations,
      );
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(
        before.stock,
      );
    },
  );

  it("files product_unresolved for goods an applied replacement leaves unresolved", async () => {
    const { manualPurchase, manualExpense } =
      await importOverManualAggregate(false);
    const finding = await replacementFinding(manualPurchase.id);
    const review = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [manualExpense.shortcode],
          lines: [
            {
              lineIndex: 0,
              expenseId: manualExpense.shortcode,
              productId: null,
            },
          ],
        },
      },
      ctx.actor,
    );
    const input = {
      id: finding.id,
      action: "apply" as const,
      reviewedFingerprint: review.reviewedFingerprint,
    };
    expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
      status: "applied",
    });
    expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
      status: "applied",
    });
    const unresolved = await getDb(ctx.db)
      .select({ id: runFinding.id })
      .from(runFinding)
      .where(
        and(
          eq(runFinding.entityId, manualPurchase.id),
          eq(runFinding.kind, "product_unresolved"),
          eq(runFinding.status, "open"),
        ),
      );
    expect(unresolved).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("associates equivalent evidence instead of duplicating a manual Purchase whose Expense is already identified", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Manual conflict member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Manual conflict vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Manual conflict account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Already-identified manual product" }),
      ctx.actor,
    );
    // This member already fully recorded the order by hand: a Purchase, an
    // Expense, AND its Product — nothing here is a replaceable aggregate.
    const manualPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "MANUAL-ORDER-2",
      date: "2026-09-19",
      statedTotal: 18,
    });
    const manualExpense = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: manualPurchase.id,
      name: "Already-identified manual product",
      cost: 18,
      date: "2026-09-19",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: existingProduct.entityId,
      productQuantity: 1,
    });

    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:manual-order-2",
        itemOperationIds: ["prepare-item:manual-order-2"],
      },
      orders: [
        {
          stableOrderId: "manual-order-2",
          itemOperationId: "prepare-item:manual-order-2",
          source: {
            kind: "vendor_export" as const,
            externalKey: "manual-conflict:order:1",
            checksum: checksum("7"),
          },
          evidenceChecksum: checksum("8"),
          extractionRevision: "manual-conflict@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "MANUAL-ORDER-2",
              orderedAt: "2026-09-19T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 18,
              lines: [
                {
                  title: "Already-identified manual product",
                  amount: 18,
                  lineKind: "principal" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["manual-order-2:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:manual-order-2" },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "manual-order-2",
          stableLineId: "manual-order-2:line-1",
          resolution: {
            kind: "existing" as const,
            productId: (
              await getDb(ctx.db)
                .select({ shortcode: product.shortcode })
                .from(product)
                .where(eq(product.id, existingProduct.entityId))
            )[0]!.shortcode,
          },
        },
      ],
    });
    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(result.items[0]?.outcome).toBe("updated");
    expect(result.items[0]?.findingCount).toBe(0);

    const purchasesForOrder = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "MANUAL-ORDER-2"));
    expect(purchasesForOrder).toHaveLength(1);

    const liveExpenses = await getDb(ctx.db)
      .select({ id: expense.id })
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, manualPurchase.id),
          isNull(expense.deletedAt),
        ),
      );
    // No second Expense was created, and the original manual line survives
    // untouched.
    expect(liveExpenses).toEqual([{ id: manualExpense.id }]);

    const findings = await getDb(ctx.db)
      .select({ kind: runFinding.kind })
      .from(runFinding)
      .where(eq(runFinding.entityId, manualPurchase.id));
    expect(findings).toEqual([]);
  });
});

// A no-ID original erases a known order id or splits from its reviewed
// Purchase; two identical no-ID orders through Vendor aliases collapse into
// one; an unfamiliar Vendor is created twice; a Product or Vendor removed
// after prepare still receives a Purchase, Expenses, or source bindings.
describe("member prepare and commit identity fences", () => {
  const ctx = withTestDb();

  async function scope() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Identity fence member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic service merchant",
    });
    return { party, vendor };
  }

  const candidate = (
    orderId: string | null,
    amount = 10,
    title = "Synthetic annual service",
  ): ExtractedOrderCandidate => ({
    orderId,
    orderedAt: "2026-10-01T12:00:00Z",
    merchant: "Synthetic service merchant",
    currency: "USD",
    printedGrandTotal: amount,
    lines: [{ title, amount, quantity: 1, lineKind: "principal" }],
    payments: [],
    allShipmentsDelivered: true,
  });
  const source = {
    kind: "receipt_photo" as const,
    externalKey: "synthetic:identity-fence",
    checksum: checksum("a"),
  };

  it("converges a fresh no-ID original on the existing Purchase without erasing its order identity", async () => {
    const { vendor } = await scope();
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "ORDER-ONE",
    });
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "no-id-original",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "no-id-original",
          vendorId: vendor.shortcode,
          targetPurchaseId: existing.shortcode,
          source,
          extraction: { status: "ready", candidate: candidate(null) },
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBe(existing.shortcode);
    const rows = await getDb(ctx.db).select().from(purchase);
    expect(rows.map(({ orderId }) => orderId)).toEqual(["ORDER-ONE"]);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
  });

  it("refuses identical no-ID orders reached through different aliases of the same Vendor", async () => {
    const { vendor } = await scope();
    await expect(
      prepareMemberImport(ctx.db, ctx.actor, {
        key: "no-id-aliases",
        orders: [
          {
            stableOrderId: "by-id",
            vendorId: vendor.shortcode,
            source,
            extraction: { status: "ready", candidate: candidate(null) },
          },
          {
            stableOrderId: "by-name",
            vendor: { name: vendor.name },
            source,
            extraction: { status: "ready", candidate: candidate(null) },
          },
        ],
      }),
    ).rejects.toThrow(/same Vendor and order id/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
  });

  it("creates one unfamiliar Vendor for two distinct orders and no physical service Products", async () => {
    await scope();
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "unfamiliar-vendor",
      defaultTrade: "other",
      orders: ["ORDER-ONE", "ORDER-TWO"].map((orderId, index) => ({
        stableOrderId: orderId.toLowerCase(),
        vendor: { name: "Synthetic unfamiliar merchant" },
        source,
        extraction: {
          status: "ready" as const,
          candidate: candidate(orderId, 10 + index * 10),
        },
      })),
    });
    expect(new Set(committed.items.map((item) => item.purchaseId)).size).toBe(
      2,
    );
    expect(
      await getDb(ctx.db)
        .select({ id: vendorTable.id })
        .from(vendorTable)
        .where(eq(vendorTable.name, "Synthetic unfamiliar merchant")),
    ).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
  });

  async function preparedProductOrder() {
    const { vendor } = await scope();
    const selected = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic copper instrument" }),
      ctx.actor,
    );
    const [row] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, selected.entityId));
    const order: MemberImportOrder = {
      stableOrderId: "selected-product",
      vendorId: vendor.shortcode,
      source,
      extraction: {
        status: "ready",
        candidate: candidate(
          "SYNTHETIC-REUSE",
          24,
          "Synthetic copper instrument",
        ),
      },
      resolutions: [
        {
          kind: "existing",
          productId: parseShortcodeFor("product", row!.shortcode),
        },
      ],
    };
    const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "selected-product",
      orders: [order],
      defaultTrade: "other",
    });
    return { vendor, selected, preparation };
  }

  async function expectNothingWritten() {
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceProduct)).toEqual([]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  }

  it("refuses a Product deleted after prepare before committing Purchase, expenses, or source bindings", async () => {
    const { selected, preparation } = await preparedProductOrder();
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, selected.entityId));
    await expect(preparation.commit()).rejects.toThrow(/Product/);
    await expectNothingWritten();
  });

  it("refuses a Vendor deleted after prepare before committing Purchase, expenses, or source bindings", async () => {
    const { vendor, preparation } = await preparedProductOrder();
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ deletedAt: new Date() })
      .where(eq(vendorTable.id, vendor.id));
    await expect(preparation.commit()).rejects.toThrow(/deleted or merged/);
    await expectNothingWritten();
  });

  const storeName = "The Synthetic Hardware Store";

  async function senderVendor() {
    const { party } = await scope();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Hardware",
      orderEmailSenders: ["orders@hardware.example"],
    });
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "ORDER-ONE",
    });
    return { party, vendor, existing };
  }

  const orderMail = (
    ledgerPartyId: Parameters<typeof retainedMailFixture>[1]["ledgerPartyId"],
    sender: string,
  ) =>
    retainedMailFixture(ctx.db, {
      ledgerPartyId,
      messageId: `synthetic-${sender.length}`,
      checksum: checksum("c"),
      sender,
    });

  const vendorRows = () =>
    getDb(ctx.db)
      .select({
        id: vendorTable.id,
        name: vendorTable.name,
        aliases: vendorTable.aliases,
      })
      .from(vendorTable)
      // Every case starts from scope()'s own unrelated Vendor.
      .where(ne(vendorTable.name, "Synthetic service merchant"));

  it("converges an order Email on the Vendor its exact sender proves and learns the merchant name", async () => {
    const { party, vendor, existing } = await senderVendor();
    const mail = await orderMail(
      party.id,
      `"${storeName}" <Orders@Hardware.example>`,
    );
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "sender-proof",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "sender-proof",
          vendor: { name: storeName },
          source: mailSource(mail),
          extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBe(existing.shortcode);
    expect(await vendorRows()).toEqual([
      { id: vendor.id, name: vendor.name, aliases: [storeName] },
    ]);
    const sources = await getDb(ctx.db)
      .select({ quote: entitySource.quote })
      .from(entitySource)
      .where(eq(entitySource.entityId, vendor.id));
    expect(sources.map(({ quote }) => quote)).toEqual([
      expect.stringContaining("orders@hardware.example"),
    ]);
  });

  it("finds a Vendor by an exact alias apart from letter case", async () => {
    const { vendor, existing } = await senderVendor();
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ aliases: [storeName] })
      .where(eq(vendorTable.id, vendor.id));
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "alias",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "alias",
          vendor: { name: `  ${storeName.toLowerCase()} ` },
          source,
          extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBe(existing.shortcode);
    expect((await vendorRows()).map(({ id }) => id)).toEqual([vendor.id]);
  });

  it("does not treat a shared sender domain as Sender proof", async () => {
    const { party, vendor } = await senderVendor();
    const mail = await orderMail(party.id, "promotions@hardware.example");
    await memberImport(ctx.db, ctx.actor, {
      key: "shared-domain",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "shared-domain",
          vendor: { name: "Synthetic Hardware Outlet" },
          source: mailSource(mail),
          extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
        },
      ],
    });
    const rows = await vendorRows();
    expect(rows).toHaveLength(2);
    expect(rows.find(({ id }) => id === vendor.id)?.aliases).toEqual([]);
  });

  it("refuses to learn a merchant name another Vendor already answers to", async () => {
    const { party, vendor } = await senderVendor();
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: storeName,
    });
    const mail = await orderMail(party.id, "orders@hardware.example");
    await expect(
      prepareMemberImport(ctx.db, ctx.actor, {
        key: "sender-name-conflict",
        orders: [
          {
            stableOrderId: "sender-name-conflict",
            vendor: { name: storeName },
            source: mailSource(mail),
            extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
          },
        ],
      }),
    ).rejects.toThrow(new RegExp(other.shortcode));
    expect(
      (await vendorRows()).find(({ id }) => id === vendor.id)?.aliases,
    ).toEqual([]);
  });

  it("refuses a merchant name that is an alias of two Vendors", async () => {
    await scope();
    for (const name of ["Synthetic Hardware East", "Synthetic Hardware West"])
      await insertWithShortcode(ctx.db, "vendor", {
        name,
        aliases: [storeName],
      });
    await expect(
      prepareMemberImport(ctx.db, ctx.actor, {
        key: "ambiguous-alias",
        orders: [
          {
            stableOrderId: "ambiguous-alias",
            vendor: { name: storeName },
            source,
            extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
          },
        ],
      }),
    ).rejects.toThrow(/VEN-.*VEN-/);
  });

  async function existingProduct(input: {
    name: string;
    manufacturer: string;
    aliases?: string[];
  }) {
    const created = await createProductFixture(
      ctx.db,
      makeProductInput(input),
      ctx.actor,
    );
    const [row] = await getDb(ctx.db)
      .select({ id: product.id, shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, created.entityId));
    if (!row) throw new Error("Product fixture was not created");
    return row;
  }

  const productOrder = (
    vendorId: MemberImportOrder["vendorId"],
    line: { title: string; sku?: string },
    resolution: NonNullable<MemberImportOrder["resolutions"]>[number],
  ): MemberImportOrder => ({
    stableOrderId: "new-product",
    vendorId,
    source,
    extraction: {
      status: "ready",
      candidate: {
        ...candidate("SYNTHETIC-NEW", 24),
        lines: [{ ...line, amount: 24, quantity: 1, lineKind: "principal" }],
      },
    },
    resolutions: [resolution],
  });

  const liveProductIds = async () =>
    (await getDb(ctx.db).select({ id: product.id }).from(product))
      .map(({ id }) => id)
      .sort();

  it.each([
    { matched: "name", title: "  synthetic COPPER instrument " },
    { matched: "alias", title: "Synthetic brass gauge" },
  ])(
    "refuses an explicit new Product that would fork an exact $matched identity",
    async ({ title }) => {
      const { vendor } = await scope();
      const existing = await existingProduct({
        name: "Synthetic copper instrument",
        manufacturer: "Synthetic works",
        aliases: ["Synthetic brass gauge"],
      });
      const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
        key: "exact-name-fork",
        defaultTrade: "other",
        orders: [productOrder(vendor.shortcode, { title }, { kind: "new" })],
      });
      expect(
        preparation.prepared.orders[0]?.lines[0]?.candidates[0],
      ).toMatchObject({ productId: existing.shortcode, exactNameMatch: true });
      await expect(preparation.commit()).rejects.toThrow(
        new RegExp(existing.shortcode),
      );
      await expectNothingWritten();
      expect(await liveProductIds()).toEqual([existing.id]);
    },
  );

  async function identifierOwner() {
    const { vendor } = await scope();
    const owner = await existingProduct({
      name: "Synthetic steel fitting",
      manufacturer: "Synthetic works",
    });
    await withTransaction(ctx.db, async (tx) => {
      await tx.insert(externalSource).values({
        slug: "synthetic-merchant",
        label: "Synthetic merchant catalog",
        vendorId: vendor.id,
      });
      await tx.insert(entityExternalId).values({
        entityId: owner.id,
        entityKind: "product" as const,
        source: "synthetic-merchant",
        kind: "retailer_sku",
        externalId: "SYN-1001",
        isPrimary: true,
      });
    });
    return { vendor, owner };
  }

  it("refuses an explicit new Product whose line identifier another Product owns, even when marked distinct", async () => {
    const { vendor, owner } = await identifierOwner();
    const line = { title: "Synthetic fitting, relisted", sku: "SYN-1001" };
    const resolutions: Array<
      [string, NonNullable<MemberImportOrder["resolutions"]>[number]]
    > = [
      ["identifier-fork", { kind: "new" }],
      [
        "identifier-fork-distinct",
        {
          kind: "new" as const,
          distinctFrom: [
            {
              productId: parseShortcodeFor("product", owner.shortcode),
              url: "https://example.com/listing/fitting",
              quote: "Relisted under a new title.",
            },
          ],
        },
      ],
    ];
    for (const [key, resolution] of resolutions) {
      const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
        key,
        defaultTrade: "other",
        orders: [productOrder(vendor.shortcode, line, resolution)],
      });
      await expect(preparation.commit()).rejects.toThrow(
        new RegExp(`${owner.shortcode}.*SYN-1001|SYN-1001.*${owner.shortcode}`),
      );
      await expectNothingWritten();
      expect(await liveProductIds()).toEqual([owner.id]);
    }
  });

  it("refuses an explicit new Product whose SKU is a barcode another Product owns", async () => {
    const { vendor } = await scope();
    const owner = await existingProduct({
      name: "Synthetic labeled fitting",
      manufacturer: "Synthetic works",
    });
    await withTransaction(ctx.db, async (tx) => {
      await ensureExternalSources(tx, ["gtin"]);
      await tx.insert(entityExternalId).values({
        entityId: owner.id,
        entityKind: "product" as const,
        source: "gtin",
        kind: "gtin_14",
        externalId: "00012345678905",
        isPrimary: true,
      });
    });
    const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "barcode-fork",
      defaultTrade: "other",
      orders: [
        productOrder(
          vendor.shortcode,
          { title: "Fitting from a receipt", sku: "012345678905" },
          { kind: "new" },
        ),
      ],
    });
    expect(
      preparation.prepared.orders[0]?.lines[0]?.candidates[0],
    ).toMatchObject({ productId: owner.shortcode, exactIdentifierMatch: true });
    await expect(preparation.commit()).rejects.toThrow(
      new RegExp(owner.shortcode),
    );
    await expectNothingWritten();
  });

  it("creates one Product for two new lines with the same title in one order", async () => {
    const { vendor } = await scope();
    const order = productOrder(
      vendor.shortcode,
      { title: "Synthetic hose clamp" },
      { kind: "new" },
    );
    const lines = order.extraction.candidate!.lines;
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "same-title",
      defaultTrade: "other",
      orders: [
        {
          ...order,
          extraction: {
            status: "ready",
            candidate: {
              ...order.extraction.candidate!,
              printedGrandTotal: 48,
              lines: [...lines, ...lines],
            },
          },
          resolutions: [{ kind: "new" }, { kind: "new" }],
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBeTruthy();
    expect(await liveProductIds()).toHaveLength(1);
  });

  it("creates a Product beside an exact name match only with a sourced distinct-from decision", async () => {
    const { vendor } = await scope();
    const existing = await existingProduct({
      name: "Synthetic copper instrument",
      manufacturer: "Synthetic works",
    });
    const quote = "Sold as a two-pack; the single unit is a separate listing.";
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "distinct-from",
      defaultTrade: "other",
      orders: [
        productOrder(
          vendor.shortcode,
          { title: "Synthetic Copper Instrument" },
          {
            kind: "new",
            distinctFrom: [
              {
                productId: parseShortcodeFor("product", existing.shortcode),
                url: "https://example.com/listing/two-pack",
                quote,
              },
            ],
          },
        ),
      ],
    });
    expect(committed.items[0]?.purchaseId).toBeTruthy();
    const created = (await liveProductIds()).filter((id) => id !== existing.id);
    expect(created).toHaveLength(1);
    const sources = await getDb(ctx.db)
      .select({ url: entitySource.url, quote: entitySource.quote })
      .from(entitySource)
      .where(eq(entitySource.entityId, created[0]!));
    expect(sources).toContainEqual({
      url: "https://example.com/listing/two-pack",
      quote,
    });
  });

  it("refuses a distinct Product that would reuse the identical name instead of failing on the name index", async () => {
    const { vendor } = await scope();
    const existing = await existingProduct({
      name: "Synthetic copper instrument",
      manufacturer: "",
    });
    const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "identical-name",
      defaultTrade: "other",
      orders: [
        productOrder(
          vendor.shortcode,
          { title: "Synthetic copper instrument" },
          {
            kind: "new",
            distinctFrom: [
              {
                productId: parseShortcodeFor("product", existing.shortcode),
                url: "https://example.com/listing/variant",
                quote: "A different variant sold under the same title.",
              },
            ],
          },
        ),
      ],
    });
    await expect(preparation.commit()).rejects.toThrow(
      new RegExp(`identical name.*${existing.shortcode}`),
    );
    await expectNothingWritten();
  });
});

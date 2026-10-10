import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  type ExtractedOrderCandidate,
  commitPurchaseImportInput,
  aggregateReplacementSnapshot,
  proposedImportFix,
} from "@cubby/schemas/purchase-import";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityExternalId,
  externalSource,
  auditLog,
  expense,
  financialTransactionAllocation,
  importSourceClaim,
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

import {
  aggregateReplacementApprovalFingerprint,
  loadAggregateReplacementSnapshot,
} from "./aggregate-replacement";
import { resolveRunFinding } from "./findings";
import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startImportRunFixture } from "./import-run.fixtures";
import {
  memberImport,
  prepareMemberImport,
  type MemberImportOrder,
} from "./order-import.fixtures";

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
            kind: "browser_order" as const,
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
              kind: "browser_order" as const,
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
            kind: "browser_order" as const,
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
            productId: productRow.shortcode,
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
            kind: "browser_order" as const,
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
            kind: "browser_order" as const,
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
            productId: productRow.shortcode,
          },
        },
      ],
    });
    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    return { manualPurchase, manualExpense, existingProduct, category, result };
  }

  it("replaces a categorized aggregate with an uncategorized tax line", async () => {
    const { manualPurchase, manualExpense, category } =
      await importOverManualAggregate(false, true, true);
    if (!category) throw new Error("Expected the category fixture");
    const [finding] = await getDb(ctx.db)
      .select({ id: runFinding.id, proposedFix: runFinding.proposedFix })
      .from(runFinding)
      .where(
        and(
          eq(runFinding.entityId, manualPurchase.id),
          eq(runFinding.kind, "duplicate_lines"),
        ),
      );
    if (!finding) throw new Error("Expected replacement finding");
    const fix = proposedImportFix.parse(finding.proposedFix);
    if (fix.kind !== "replace_aggregate_line")
      throw new Error("Expected replacement preview");
    await resolveRunFinding(
      ctx.db,
      {
        id: finding.id,
        action: "apply",
        reviewedFingerprint: fix.reviewSnapshot?.fingerprint,
      },
      ctx.actor,
    );
    const rows = await getDb(ctx.db)
      .select({
        name: expense.name,
        lineKind: expense.lineKind,
        spendingCategoryId: expense.spendingCategoryId,
      })
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, manualPurchase.id),
          isNull(expense.deletedAt),
        ),
      );
    expect(
      rows.find((row) => row.lineKind === "principal")?.spendingCategoryId,
    ).toBe(category.id);
    expect(
      rows.find((row) => row.lineKind === "tax")?.spendingCategoryId,
    ).toBeNull();
    expect(rows).toHaveLength(2);
    expect(
      await getDb(ctx.db).query.expense.findFirst({
        where: eq(expense.id, manualExpense.id),
        columns: { deletedAt: true },
      }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])(
    "keeps an exact aggregate until its unchanged replacement preview is approved (edited: %s, orderless: %s, proposal changed: %s)",
    async (editAfterPreview, targetOrderless, editProposal) => {
      const { manualPurchase, manualExpense, existingProduct, result } =
        await importOverManualAggregate(targetOrderless);
      // The order was already a Purchase (found by vendor + orderId), so this
      // is an update to it, never a second Purchase for the same order.
      expect(result.items[0]?.outcome).toBe("updated");
      expect(result.items[0]?.purchaseId).toBe(manualPurchase.shortcode);

      const purchasesForOrder = await getDb(ctx.db)
        .select({ id: purchase.id })
        .from(purchase)
        .where(eq(purchase.orderId, "MANUAL-ORDER-1"));
      expect(purchasesForOrder).toHaveLength(1);
      expect(purchasesForOrder[0]?.id).toBe(manualPurchase.id);

      const [pendingAggregate] = await getDb(ctx.db)
        .select({ deletedAt: expense.deletedAt })
        .from(expense)
        .where(eq(expense.id, manualExpense.id));
      expect(pendingAggregate?.deletedAt).toBeNull();
      const [replacementFinding] = await getDb(ctx.db)
        .select({ id: runFinding.id, proposedFix: runFinding.proposedFix })
        .from(runFinding)
        .where(
          and(
            eq(runFinding.entityId, manualPurchase.id),
            eq(runFinding.kind, "duplicate_lines"),
          ),
        );
      expect(replacementFinding?.proposedFix).toMatchObject({
        kind: "replace_aggregate_line",
      });
      if (!replacementFinding) throw new Error("Expected replacement preview");
      const reviewedFix = proposedImportFix.parse(
        replacementFinding.proposedFix,
      );
      if (reviewedFix.kind !== "replace_aggregate_line")
        throw new Error("Expected replacement fix");
      const reviewSnapshot = aggregateReplacementSnapshot.parse(
        reviewedFix.reviewSnapshot,
      );
      await expect(
        resolveRunFinding(
          ctx.db,
          { id: replacementFinding.id, action: "apply" },
          ctx.actor,
        ),
      ).rejects.toThrow(/preview|review/i);

      if (editAfterPreview) {
        await getDb(ctx.db)
          .update(expense)
          .set({ notes: "Changed after preview" })
          .where(eq(expense.id, manualExpense.id));
      }
      if (editProposal) {
        await getDb(ctx.db)
          .update(runFinding)
          .set({
            proposedFix: {
              ...reviewedFix,
              lines: reviewedFix.lines.map((line) => ({
                ...line,
                title: "Different unreviewed item",
              })),
            },
          })
          .where(eq(runFinding.id, replacementFinding.id));
      }
      const previewChanged = editAfterPreview || editProposal;
      const outcome = await resolveRunFinding(
        ctx.db,
        {
          id: replacementFinding.id,
          action: "apply",
          reviewedFingerprint: reviewSnapshot.fingerprint,
        },
        ctx.actor,
      ).then(
        () => "applied",
        (error) => (error instanceof Error ? error.message : String(error)),
      );
      expect(outcome).toMatch(
        previewChanged ? /changed|preview/i : /^applied$/,
      );
      const original = await getDb(ctx.db).query.expense.findFirst({
        where: eq(expense.id, manualExpense.id),
      });
      expect(original?.deletedAt !== null).toBe(!previewChanged);
      if (previewChanged) return;

      const liveExpenses = await getDb(ctx.db)
        .select({
          id: expense.id,
          productId: expense.productId,
          cost: expense.cost,
        })
        .from(expense)
        .where(
          and(
            eq(expense.purchaseId, manualPurchase.id),
            isNull(expense.deletedAt),
          ),
        );
      // Approval replaces the aggregate; import itself preserved it.
      expect(liveExpenses).toHaveLength(1);
      expect(liveExpenses[0]?.productId).toBe(existingProduct.entityId);
      expect(Number(liveExpenses[0]?.cost)).toBe(45);

      const [deletedManualExpense] = await getDb(ctx.db)
        .select({ deletedAt: expense.deletedAt })
        .from(expense)
        .where(eq(expense.id, manualExpense.id));
      expect(deletedManualExpense?.deletedAt).not.toBeNull();
    },
  );

  // Delivery mail asks to receive only Product lines or open unresolved
  // goods, so goods a replacement leaves unresolved must keep that finding.
  it("files product_unresolved for goods an applied replacement leaves unresolved", async () => {
    const { manualPurchase, manualExpense } =
      await importOverManualAggregate(false);
    const [finding] = await getDb(ctx.db)
      .select({ id: runFinding.id, proposedFix: runFinding.proposedFix })
      .from(runFinding)
      .where(
        and(
          eq(runFinding.entityId, manualPurchase.id),
          eq(runFinding.kind, "duplicate_lines"),
        ),
      );
    const fix = proposedImportFix.parse(finding?.proposedFix);
    if (!finding || fix.kind !== "replace_aggregate_line")
      throw new Error("Expected a replacement preview");
    // The member reviewed the line as goods they could not match yet.
    const identities = (fix.reviewedLineIdentities ?? []).map((identity) => ({
      ...identity,
      productId: null,
      promote: false,
      unresolvedReason: "The receipt names no model.",
    }));
    const { snapshot } = await withTransaction(ctx.db, (tx) =>
      loadAggregateReplacementSnapshot(tx, manualPurchase.id, manualExpense.id),
    );
    const fingerprint = await aggregateReplacementApprovalFingerprint(
      snapshot.fingerprint,
      fix.lines,
      identities,
      fix.reviewedLineAttributions ?? [],
    );
    await getDb(ctx.db)
      .update(runFinding)
      .set({
        proposedFix: {
          ...fix,
          reviewedLineIdentities: identities,
          reviewSnapshot: { ...fix.reviewSnapshot!, fingerprint },
        },
      })
      .where(eq(runFinding.id, finding.id));
    await resolveRunFinding(
      ctx.db,
      { id: finding.id, action: "apply", reviewedFingerprint: fingerprint },
      ctx.actor,
    );
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
  });

  it("files a conflict finding instead of duplicating a manual Purchase whose Expense is already identified", async () => {
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
            kind: "browser_order" as const,
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
    expect(result.items[0]?.findingCount).toBeGreaterThan(0);

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
    expect(findings.some((row) => row.kind === "duplicate_lines")).toBe(true);
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
});

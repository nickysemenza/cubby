import { parseEntityId } from "@cubby/schemas/identifiers";
import { userId } from "@cubby/schemas/identifiers";
import type { ImportWriterInput } from "@cubby/schemas/purchase-import";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { testShortcode } from "@cubby/schemas/testing";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  importPreparedOrder,
  importSourceOrder,
  inventoryEntry,
  product,
  productCategory,
  project,
  purchase,
  purchasePaymentEvidence,
  run,
  runFinding,
  runTarget,
  user,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { effectiveExpenseTradeSql } from "~/server/repo/expense-inheritance";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { sweepPendingEnrichment } from "./enrichment-sweep";
import { loadProductPurchaseContext } from "./research-context";
import { importVendorOrder } from "./writer";

// Database failure modes: an identified incomplete order demands a fabricated
// date/Expense; one source's first order suppresses its second; replay adds
// Expense lines; later evidence creates a second Purchase or replaces spend;
// a nullable first column makes an existing joined purchase line disappear.
describe("research order writes", () => {
  const ctx = withTestDb();

  async function scope() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Research fixture member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Research fixture vendor",
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "account_sync",
      trigger: "manual",
      status: "running",
    });
    return { party, vendor, runId };
  }

  // A Purchase-wide fallback would mask the member's food Project purpose in
  // a mixed order. Only genuinely unassigned newly imported lines get Other.
  it("fills unassigned imported lines after resolving Product purpose inheritance", async () => {
    const { party, vendor, runId } = await scope();
    await getDb(ctx.db)
      .insert(project)
      .values({
        shortcode: testShortcode("project", "PRJ-HSHD"),
        name: "Synthetic household purpose",
        defaultTrade: "building",
      });
    const [food] = await getDb(ctx.db)
      .select()
      .from(productCategory)
      .where(eq(productCategory.feature, "food"));
    if (!food) throw new Error("Synthetic taxonomy lacks the food feature.");
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic ingredient",
      manufacturer: "",
      categoryId: food.id,
    });
    const input: ImportWriterInput = {
      runId,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      source: {
        kind: "mail_message",
        externalKey: "gmail:synthetic:mixed-purpose",
        checksum: "c".repeat(64),
      },
      extraction: {
        status: "ready",
        candidate: {
          orderId: "EXAMPLE-MIXED-PURPOSE",
          orderedAt: "2026-09-01",
          merchant: vendor.name,
          currency: "USD",
          printedGrandTotal: 15,
          lines: [
            {
              title: item.name,
              amount: 10,
              quantity: 1,
              lineKind: "principal",
            },
            {
              title: "Synthetic service",
              amount: 4,
              quantity: 1,
              lineKind: "principal",
            },
            { title: "Printed shipping", amount: 1, lineKind: "shipping" },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
      productResolutions: [
        { kind: "existing", productId: item.id, lineIndex: 0 },
        { kind: "expense_only", lineIndex: 1 },
      ],
      primaryDocumentImageId: null,
      screenshotImageId: null,
    };
    const result = await importVendorOrder(ctx.db, input, ctx.actor.userId, {
      applyUnassignedPurposeFallback: true,
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(eq(purchase.id, parseEntityId("purchase", result.purchaseId!)));
    expect(saved?.defaultTrade).toBeNull();
    const lines = await getDb(ctx.db)
      .select({
        name: expense.name,
        cost: expense.cost,
        trade: expense.trade,
        effectiveTrade: effectiveExpenseTradeSql(),
      })
      .from(expense)
      .where(eq(expense.purchaseId, saved!.id));
    expect(lines).toEqual(
      expect.arrayContaining([
        { name: item.name, cost: 10, trade: null, effectiveTrade: "building" },
        {
          name: "Synthetic service",
          cost: 4,
          trade: "other",
          effectiveTrade: "other",
        },
        {
          name: "Printed shipping",
          cost: 1,
          trade: null,
          effectiveTrade: null,
        },
      ]),
    );
    expect(lines).toHaveLength(3);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toHaveLength(0);
    expect(
      await importVendorOrder(ctx.db, input, ctx.actor.userId, {
        applyUnassignedPurposeFallback: true,
      }),
    ).toMatchObject({ outcome: "replayed", purchaseId: result.purchaseId });
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(3);
  });

  it("imports a supported receipt without inventing purpose or replacing member attribution", async () => {
    const { party, vendor, runId } = await scope();
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "EXAMPLE-UNKNOWN-PURPOSE",
      defaultTrade: "other",
    });
    const resolved = researchWorkResolve.parse({
      workRef: crypto.randomUUID(),
      status: "verified",
      identity: {
        evidenceIds: [],
        reasoning: "The original identifies this order and item.",
      },
      orders: [
        {
          vendorRef: vendor.shortcode,
          evidenceIds: [],
          reasoning:
            "The original prints this service, its order date, and USD 10; its household purpose is unknown.",
          candidate: {
            orderId: "EXAMPLE-UNKNOWN-PURPOSE",
            orderedAt: "2026-09-01T18:00:00Z",
            merchant: vendor.name,
            currency: "USD",
            printedGrandTotal: 10,
            lines: [
              {
                title: "Synthetic service",
                amount: 10,
                quantity: 1,
                lineKind: "principal",
              },
            ],
            payments: [],
            allShipmentsDelivered: false,
          },
          productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
        },
      ],
      detail: "Supported acquisition; purpose remains unknown.",
    });
    const order = resolved.orders[0]!;
    const result = await importVendorOrder(
      ctx.db,
      {
        runId,
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        vendorAccountId: null,
        targetPurchaseId: existing.id,
        source: {
          kind: "mail_message",
          externalKey: "gmail:synthetic:unknown-purpose",
          checksum: "a".repeat(64),
        },
        extraction: { status: "ready", candidate: order.candidate },
        productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
        primaryDocumentImageId: null,
        screenshotImageId: null,
      },
      ctx.actor.userId,
    );
    const [saved] = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(eq(purchase.id, parseEntityId("purchase", result.purchaseId!)));
    expect(saved?.defaultTrade).toBe("other");
    const lines = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(eq(expense.purchaseId, saved!.id));
    expect(lines.map(({ cost }) => Number(cost))).toEqual([10]);
  });
  // A null Purchase trade can intentionally inherit a selected Project or
  // line purpose. A new receipt's fallback must not override that selection.
  it.each([
    "purchase_project",
    "line_project",
    "line_trade",
    "unassigned_purchase",
    "new_purchase",
  ] as const)(
    "fills Other only without member purpose: %s",
    async (selection) => {
      const { party, vendor, runId } = await scope();
      const parentProject = await insertWithShortcode(ctx.db, "project", {
        name: "Synthetic purpose parent",
        defaultTrade: "plumbing",
      });
      const selectedProject = await insertWithShortcode(ctx.db, "project", {
        name: "Synthetic purpose child",
        parentProjectId: parentProject.id,
      });
      const existing =
        selection === "new_purchase"
          ? undefined
          : await insertWithShortcode(ctx.db, "purchase", {
              vendorId: vendor.id,
              orderId: "EXAMPLE-MEMBER-PURPOSE",
              date: "2026-09-01",
              defaultTrade: null,
              defaultProjectId:
                selection === "purchase_project" ? selectedProject.id : null,
            });
      if (
        existing &&
        (selection === "line_project" || selection === "line_trade")
      )
        await insertWithShortcode(ctx.db, "expense", {
          purchaseId: existing.id,
          name: "Synthetic service",
          date: "2026-09-01",
          cost: 10,
          costType: "materials",
          lineKind: "principal",
          lineBasis: "item_line",
          trade: selection === "line_trade" ? "plumbing" : null,
          projectId: selection === "line_project" ? selectedProject.id : null,
        });
      const input: ImportWriterInput = {
        runId,
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        vendorAccountId: null,
        defaultTrade: "other",
        targetPurchaseId: existing?.id,
        source: {
          kind: "mail_message",
          externalKey: "gmail:synthetic:member-purpose",
          checksum: "b".repeat(64),
        },
        extraction: {
          status: "ready",
          candidate: {
            orderId: "EXAMPLE-MEMBER-PURPOSE",
            orderedAt: "2026-09-01T18:00:00Z",
            merchant: vendor.name,
            currency: "USD",
            printedGrandTotal: 10,
            lines: [
              {
                title: "Synthetic service",
                amount: 10,
                quantity: 1,
                lineKind: "principal",
              },
            ],
            payments: [],
            allShipmentsDelivered: false,
          },
        },
        productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
        primaryDocumentImageId: null,
        screenshotImageId: null,
      };
      const result = await importVendorOrder(ctx.db, input, ctx.actor.userId);
      const [saved] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, parseEntityId("purchase", result.purchaseId!)));
      const hasMemberPurpose =
        selection === "purchase_project" ||
        selection === "line_project" ||
        selection === "line_trade";
      expect(saved).toMatchObject({
        id: existing?.id ?? result.purchaseId,
        defaultTrade: hasMemberPurpose ? null : "other",
        defaultProjectId:
          selection === "purchase_project" ? selectedProject.id : null,
      });
      const savedLines = await getDb(ctx.db)
        .select({
          cost: expense.cost,
          trade: expense.trade,
          projectId: expense.projectId,
          effectiveTrade: effectiveExpenseTradeSql(),
        })
        .from(expense)
        .where(eq(expense.purchaseId, saved!.id));
      expect(savedLines).toEqual([
        {
          cost: 10,
          trade: selection === "line_trade" ? "plumbing" : null,
          projectId: selection === "line_project" ? selectedProject.id : null,
          effectiveTrade: hasMemberPurpose ? "plumbing" : "other",
        },
      ]);
      const replay = await importVendorOrder(ctx.db, input, ctx.actor.userId);
      expect(replay).toMatchObject({
        outcome: "replayed",
        purchaseId: result.purchaseId,
      });
    },
  );
  it.each(["USD", null, "CAD", "CAD-mismatch"])(
    "keeps an identified incomplete order in %s unknown, then improves it without invented spend",
    async (currency) => {
      const { party, vendor, runId } = await scope();
      const incomplete: ImportWriterInput = {
        runId,
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        vendorAccountId: null,
        defaultTrade: "other",
        source: {
          kind: "mail_message",
          externalKey: "gmail:synthetic-mailbox:shipment",
          checksum: "a".repeat(64),
        },
        extraction: {
          status: "ready",
          candidate: {
            orderId: "EXAMPLE-101",
            orderedAt: currency === "USD" ? null : "2026-09-01T18:00:00Z",
            merchant: "Research fixture vendor",
            currency: currency === "CAD-mismatch" ? "CAD" : currency,
            printedGrandTotal: currency === "USD" ? null : 24,
            lines: [],
            payments: currency === "USD" ? [] : [{ amount: 24 }],
            allShipmentsDelivered: false,
          },
        },
        primaryDocumentImageId: null,
        screenshotImageId: null,
        productResolutions: [],
      };
      if (
        currency === "CAD-mismatch" &&
        incomplete.extraction.status === "ready"
      )
        incomplete.extraction = {
          ...incomplete.extraction,
          status: "needs_review",
          reason: "sum_mismatch",
          detail: "The foreign-unit total differs from priced lines.",
        };
      const first = await importVendorOrder(
        ctx.db,
        incomplete,
        ctx.actor.userId,
      );
      expect(first.purchaseId).not.toBeNull();
      const [saved] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, parseEntityId("purchase", first.purchaseId)));
      expect(saved).toMatchObject({
        date: currency === "USD" ? null : "2026-09-01",
        statedTotal: null,
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(purchasePaymentEvidence)
          .where(eq(purchasePaymentEvidence.purchaseId, saved!.id)),
      ).toEqual([]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(expense)
          .where(
            eq(expense.purchaseId, parseEntityId("purchase", first.purchaseId)),
          ),
      ).toEqual([]);
      const confirmation: ImportWriterInput = {
        ...incomplete,
        source: {
          kind: "mail_message",
          externalKey: "gmail:synthetic-mailbox:confirmation",
          checksum: "b".repeat(64),
        },
        extraction: {
          status: "ready",
          candidate: {
            ...incomplete.extraction.candidate!,
            currency: "USD",
            payments: [],
            orderedAt: "2026-09-01T18:00:00Z",
            printedGrandTotal: 24,
            lines: [
              {
                title: "Workshop admission",
                amount: 24,
                lineKind: "principal",
              },
            ],
          },
        },
        productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
      };
      const improved = await importVendorOrder(
        ctx.db,
        confirmation,
        ctx.actor.userId,
      );
      expect(improved.purchaseId).toBe(first.purchaseId);
      await importVendorOrder(ctx.db, confirmation, ctx.actor.userId);
      const [final] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, parseEntityId("purchase", first.purchaseId)));
      expect(final).toMatchObject({ date: "2026-09-01", statedTotal: 24 });
      expect(
        await getDb(ctx.db)
          .select({ cost: expense.cost, productId: expense.productId })
          .from(expense)
          .where(
            eq(expense.purchaseId, parseEntityId("purchase", first.purchaseId)),
          ),
      ).toEqual([{ cost: 24, productId: null }]);
    },
  );

  it("retains two orders from one source and replays both without duplicate Expenses", async () => {
    const { party, vendor, runId } = await scope();
    const input: ImportWriterInput = {
      runId,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      defaultTrade: "other",
      source: {
        kind: "mail_message",
        externalKey: "gmail:synthetic-mailbox:consolidated",
        checksum: "c".repeat(64),
      },
      extraction: {
        status: "ready",
        candidate: {
          orderId: "EXAMPLE-101",
          orderedAt: "2026-09-01T18:00:00Z",
          merchant: "Research fixture vendor",
          currency: "USD",
          printedGrandTotal: 24,
          lines: [
            { title: "Workshop admission", amount: 24, lineKind: "principal" },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
      primaryDocumentImageId: null,
      screenshotImageId: null,
      productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
    };
    const other: ImportWriterInput = {
      ...input,
      extraction: {
        status: "ready",
        candidate: {
          ...input.extraction.candidate!,
          orderId: "EXAMPLE-102",
          printedGrandTotal: 18,
          lines: [
            { title: "Second workshop", amount: 18, lineKind: "principal" },
          ],
        },
      },
    };
    const first = await importVendorOrder(ctx.db, input, ctx.actor.userId);
    const second = await importVendorOrder(ctx.db, other, ctx.actor.userId);
    expect(second.purchaseId).not.toBe(first.purchaseId);
    expect(
      (await importVendorOrder(ctx.db, input, ctx.actor.userId)).purchaseId,
    ).toBe(first.purchaseId);
    expect(
      (await importVendorOrder(ctx.db, other, ctx.actor.userId)).purchaseId,
    ).toBe(second.purchaseId);
    const orders = await getDb(ctx.db)
      .select({ orderId: purchase.orderId, id: purchase.id })
      .from(purchase)
      .where(eq(purchase.vendorId, vendor.id));
    expect(orders.map((order) => order.orderId).sort()).toEqual([
      "EXAMPLE-101",
      "EXAMPLE-102",
    ]);
    const lines = await getDb(ctx.db)
      .select({ cost: expense.cost })
      .from(expense)
      .innerJoin(purchase, eq(expense.purchaseId, purchase.id))
      .where(and(eq(purchase.vendorId, vendor.id), eq(purchase.runId, runId)));
    expect(
      lines.map((line) => line.cost).sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([18, 24]);
  });

  it("keeps expense-only shared-SKU lines stock-neutral and repairs missed research admission from committed originals once", async () => {
    const { party, vendor, runId } = await scope();
    const page = "https://shop.example.test/products/example-jar";
    const input: ImportWriterInput = {
      runId,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      defaultTrade: "other",
      source: {
        kind: "mail_message",
        externalKey: "gmail:synthetic-mailbox:shared-variant",
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
            {
              title: "Example small jar",
              amount: 5,
              quantity: 1,
              sku: "EXAMPLE-JAR-SMALL",
              productUrl: page,
              lineKind: "principal",
            },
            {
              title: "Example jar, small size",
              amount: 5,
              quantity: 1,
              sku: "EXAMPLE-JAR-SMALL",
              productUrl: page,
              lineKind: "principal",
            },
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
      primaryDocumentImageId: null,
      screenshotImageId: null,
      productResolutions: [
        { kind: "new", lineIndex: 0 },
        { kind: "new", lineIndex: 1 },
        { kind: "expense_only", lineIndex: 2 },
      ],
    };
    const imported = await importVendorOrder(ctx.db, input, ctx.actor.userId);
    if (!parseEntityId("purchase", imported.purchaseId))
      throw new Error("Synthetic import was not saved.");
    const lines = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(
        eq(expense.purchaseId, parseEntityId("purchase", imported.purchaseId)),
      )
      .orderBy(expense.cost, expense.name);
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
        .where(eq(runFinding.runId, runId)),
    ).toEqual([{ kind: "arrived" }]);
    // Simulate interruption after the import commit, before its callback can
    // admit research. Discovery repairs from persisted source associations.
    expect(await getDb(ctx.db).select().from(runTarget)).toEqual([]);
    const events: unknown[] = [];
    const options = {
      queue: {
        send: async (event: PurchaseAgentEvent) => {
          events.push(event);
        },
      },
    };
    await sweepPendingEnrichment(ctx.db, options);
    await importVendorOrder(ctx.db, input, ctx.actor.userId);
    await sweepPendingEnrichment(ctx.db, options);
    const children = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "product_enrichment"));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      parentRunId: runId,
      vendorAccountId: null,
    });
    expect(await getDb(ctx.db).select().from(runTarget)).toMatchObject([
      {
        runId: children[0]?.id,
        entityKind: "product",
        entityId: productId,
        state: "pending",
      },
    ]);
    expect(events).toHaveLength(1);
    expect(
      await getDb(ctx.db)
        .select()
        .from(expense)
        .where(
          eq(
            expense.purchaseId,
            parseEntityId("purchase", imported.purchaseId),
          ),
        )
        .orderBy(expense.cost, expense.name),
    ).toEqual(lines);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("researches the accepted ordered variant after the canonical Expense description changes", async () => {
    const { party, vendor, runId } = await scope();
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Example blue small device",
      manufacturer: "",
    });
    const candidate = {
      orderId: "EXAMPLE-VARIANT",
      orderedAt: "2026-09-01T18:00:00Z",
      merchant: "Research fixture vendor",
      currency: "USD",
      printedGrandTotal: 24,
      payments: [],
      allShipmentsDelivered: false,
      lines: [
        {
          title: "Q-17 device, blue, small",
          amount: 24,
          lineKind: "principal" as const,
          sku: "Q17-BLUE-S",
          productUrl: "https://shop.example/items/q17?variant=blue-small",
        },
      ],
    };
    const input: ImportWriterInput = {
      runId,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      defaultTrade: "other",
      source: {
        kind: "mail_message",
        externalKey: "gmail:synthetic-mailbox:variant-receipt",
        checksum: "d".repeat(64),
      },
      extraction: { status: "ready", candidate },
      primaryDocumentImageId: null,
      screenshotImageId: null,
      productResolutions: [
        { kind: "existing", lineIndex: 0, productId: item.id },
      ],
    };
    const imported = await importVendorOrder(ctx.db, input, ctx.actor.userId);
    if (!parseEntityId("purchase", imported.purchaseId))
      throw new Error("Synthetic variant order was not imported");
    await getDb(ctx.db)
      .update(expense)
      .set({
        name: "Member's renamed device",
        url: "https://shop.example/items/q17?variant=red-large",
        productQuantity: 2,
      })
      .where(
        eq(expense.purchaseId, parseEntityId("purchase", imported.purchaseId)),
      );
    expect(
      await loadProductPurchaseContext(ctx.db, {
        productId: item.id,
        ledgerPartyId: party.id,
      }),
    ).toMatchObject([
      {
        orderedLine: candidate.lines[0],
        originalExtractions: [{ status: "ready", candidate }],
        currentLine: {
          name: "Member's renamed device",
          url: "https://shop.example/items/q17?variant=red-large",
          quantity: 2,
        },
      },
    ]);
    await importVendorOrder(ctx.db, input, ctx.actor.userId);
    expect(
      await getDb(ctx.db)
        .select({ name: expense.name })
        .from(expense)
        .where(
          eq(
            expense.purchaseId,
            parseEntityId("purchase", imported.purchaseId),
          ),
        ),
    ).toEqual([{ name: "Member's renamed device" }]);
  });

  it("excludes another member's prepared extraction sharing a source key and checksum", async () => {
    const { party, vendor, runId } = await scope();
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Example owned device",
      manufacturer: "",
    });
    const input: ImportWriterInput = {
      runId,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      defaultTrade: "other",
      source: {
        kind: "mail_message",
        externalKey: "synthetic-shared-source-key",
        checksum: "e".repeat(64),
      },
      extraction: {
        status: "ready",
        candidate: {
          orderId: "EXAMPLE-OWNED",
          orderedAt: "2026-09-01T18:00:00Z",
          merchant: "Research fixture vendor",
          currency: "USD",
          printedGrandTotal: 24,
          lines: [
            { title: "Small blue device", amount: 24, lineKind: "principal" },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
      primaryDocumentImageId: null,
      screenshotImageId: null,
      productResolutions: [
        { kind: "existing", lineIndex: 0, productId: item.id },
      ],
    };
    const imported = await importVendorOrder(ctx.db, input, ctx.actor.userId);
    if (!parseEntityId("purchase", imported.purchaseId))
      throw new Error("Synthetic legacy source was not imported");
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ originalOrder: null })
      .where(
        eq(
          importSourceOrder.purchaseId,
          parseEntityId("purchase", imported.purchaseId),
        ),
      );
    const otherUserId = userId.parse("synthetic-other-source-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Other synthetic owner",
      email: "other-source@example.test",
    });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other synthetic source owner",
      kind: "member",
      userId: otherUserId,
    });
    const foreignRun = await insertWithShortcode(ctx.db, "run", {
      purpose: "account_sync",
      trigger: "manual",
      status: "completed",
      ledgerPartyId: other.id,
      actorUserId: otherUserId,
      actorName: "Other synthetic owner",
      actorEmail: "other-source@example.test",
      actorLedgerPartyShortcode: other.shortcode,
      actorLedgerPartyName: other.name,
      actorLedgerPartyKind: "member",
    });
    const foreignExtraction = {
      status: "ready",
      candidate: {
        ...input.extraction.candidate!,
        lines: [
          {
            title: "Different large red device",
            amount: 24,
            lineKind: "principal",
          },
        ],
      },
    };
    await getDb(ctx.db)
      .insert(importPreparedOrder)
      .values({
        runId: foreignRun.id,
        prepareOperationId: "synthetic-foreign-preparation",
        itemOperationId: "synthetic-foreign-order",
        stableOrderId: "EXAMPLE-OWNED",
        sourceKind: input.source.kind,
        sourceExternalKey: input.source.externalKey,
        sourceChecksum: input.source.checksum,
        evidenceChecksum: input.source.checksum,
        extractionRevision: "synthetic-v1",
        extraction: foreignExtraction,
        targetFingerprint: "f".repeat(64),
        evidenceFingerprint: "f".repeat(64),
      });
    await getDb(ctx.db)
      .insert(importPreparedOrder)
      .values({
        runId,
        prepareOperationId: "synthetic-owned-preparation",
        itemOperationId: "synthetic-owned-order",
        stableOrderId: "EXAMPLE-OWNED",
        sourceKind: input.source.kind,
        sourceExternalKey: input.source.externalKey,
        sourceChecksum: input.source.checksum,
        evidenceChecksum: input.source.checksum,
        extractionRevision: "synthetic-v1",
        extraction: input.extraction,
        targetFingerprint: "a".repeat(64),
        evidenceFingerprint: "a".repeat(64),
      });
    const context = await loadProductPurchaseContext(ctx.db, {
      productId: item.id,
      ledgerPartyId: party.id,
    });
    expect(context).toHaveLength(1);
    expect(context.flatMap((source) => source.originalExtractions)).toEqual([
      input.extraction,
    ]);
    expect(
      context.flatMap((source) => source.originalExtractions),
    ).not.toContainEqual(foreignExtraction);
  });
});

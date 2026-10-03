import type { ProductId, PurchaseId } from "@cubby/schemas/identifiers";
import {
  applyValidationCorrectionsInput,
  validationDiff,
  validatePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { and, eq, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  auditLog,
  expense,
  financialTransactionAllocation,
  ledgerParty,
  product,
  purchase,
  run as runTable,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { preparePurchaseImport, validatePurchaseImport } from "./import-orders";
import { startTargetedRun } from "./run-service";
import { applyValidationCorrections } from "./validation-corrections";

/*
 * Failure modes this file pins (written before the implementation):
 *  - validation records typed, versioned corrections; raw_evidence_drift and a
 *    foreign-currency plan offer none;
 *  - a partial selection applies only that subset and re-derives the rest;
 *  - the Purchase or an Expense changing between validate and apply refuses
 *    with raw diagnostics and writes nothing;
 *  - duplicate identical lines are paired by multiplicity;
 *  - an explicit Product is never replaced (it is a note, not selectable);
 *  - the same operation id replays, a different input is refused;
 *  - a failure after earlier writes rolls the whole set back;
 *  - a deleted Purchase refuses; settlement allocations never change.
 */

const checksum = (digit: string) => digit.repeat(64);

type LiveLine = {
  name: string;
  cost: number;
  lineKind?: "principal" | "tax" | "shipping";
  productId?: ProductId | null;
  productQuantity?: number | null;
};
const liveProduct = (line: LiveLine, baseProduct: ProductId) => {
  const principal = (line.lineKind ?? "principal") === "principal";
  const productId =
    line.productId === undefined
      ? principal
        ? baseProduct
        : null
      : line.productId;
  return {
    productId,
    productQuantity:
      line.productQuantity === undefined
        ? productId
          ? 1
          : null
        : line.productQuantity,
  };
};
type PlanLine = {
  title: string;
  amount: number;
  lineKind?: "principal" | "tax" | "shipping";
  quantity?: number;
  /** Product shortcode (existing) for a principal line. */
  product?: string;
};

describe("apply a reviewed purchase-validation diff", () => {
  const ctx = withTestDb();
  let sequence = 0;

  const scenario = async (options: {
    live: LiveLine[];
    plan: PlanLine[];
    liveStatedTotal?: number;
    planStatedTotal?: number;
    currency?: string;
    sourceChecksum?: string;
    withAllocation?: boolean;
  }) => {
    const n = ++sequence;
    const [existingParty] = await getDb(ctx.db)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(eq(ledgerParty.userId, ctx.actor.userId))
      .limit(1);
    const party =
      existingParty ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Corrections member",
        kind: "member",
        userId: ctx.actor.userId,
      }));
    // Principal lines default to one shared existing Product so a scenario only
    // differs from the plan in the fields it names.
    const base = await createProductFixture(
      ctx.db,
      makeProductInput({ name: `Corrections base product ${n}` }),
      ctx.actor,
    );
    const [baseRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, base.entityId));
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Corrections vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const orderId = `ORDER-CORRECT-${n}`;
    const livePurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId,
      date: "2026-09-20",
      statedTotal: options.liveStatedTotal ?? 10,
    });
    const liveExpenses = [];
    for (const line of options.live) {
      liveExpenses.push(
        await insertWithShortcode(ctx.db, "expense", {
          purchaseId: livePurchase.id,
          name: line.name,
          cost: line.cost,
          date: "2026-09-20",
          lineKind: line.lineKind ?? "principal",
          lineBasis: "item_line",
          costType: "materials",
          trade: "other",
          future: false,
          ...liveProduct(line, base.entityId),
        }),
      );
    }
    let allocationId: string | null = null;
    if (options.withAllocation) {
      const account = await insertWithShortcode(ctx.db, "financialAccount", {
        name: `Corrections card ${n}`,
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: party.id,
      });
      const charge = await insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 10,
        transactionDate: null,
        postedDate: "2026-09-21",
      });
      const [allocation] = await getDb(ctx.db)
        .insert(financialTransactionAllocation)
        .values({
          transactionId: charge.id,
          purchaseId: livePurchase.id,
          amount: 10,
        })
        .returning({ id: financialTransactionAllocation.id });
      allocationId = allocation!.id;
    }
    const started = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "purchase_validation",
      vendorId: vendor.id,
      vendorAccountId: null,
      trigger: "manual",
      targets: [
        {
          kind: "purchase",
          purchaseId: livePurchase.id,
          sourceKind: "browser_order",
          sourceExternalKey: `validation:${orderId}`,
          targetFingerprint: checksum("c"),
          evidenceFingerprint: checksum("a"),
        },
      ],
    });
    if (!started.created) throw new Error("Validation run was blocked");
    await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          runId: started.run.id,
          operationId: `prepare:${n}`,
          itemOperationIds: [`item:${n}`],
        },
        orders: [
          {
            stableOrderId: `order-${n}`,
            itemOperationId: `item:${n}`,
            source: {
              kind: "browser_order",
              externalKey: `validation:${orderId}`,
              checksum: options.sourceChecksum ?? checksum("a"),
            },
            evidenceChecksum: checksum("b"),
            extractionRevision: "validation@1",
            extraction: {
              status: "ready",
              candidate: {
                orderId,
                orderedAt: "2026-09-20T12:00:00.000Z",
                merchant: "Example",
                currency: options.currency ?? "USD",
                printedGrandTotal: options.planStatedTotal ?? 10,
                lines: options.plan.map((line) => ({
                  title: line.title,
                  amount: line.amount,
                  lineKind: line.lineKind ?? "principal",
                  quantity:
                    (line.lineKind ?? "principal") === "principal"
                      ? (line.quantity ?? 1)
                      : undefined,
                })),
                payments: [],
                allShipmentsDelivered: true,
              },
            },
            lineIds: options.plan.map((_, i) => `line-${n}-${i}`),
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    const validation = await validatePurchaseImport(
      ctx.db,
      validatePurchaseImportInput.parse({
        _runExecution: { runId: started.run.id, operationId: `validate:${n}` },
        prepareOperationId: `prepare:${n}`,
        resolutions: options.plan.flatMap((line, i) =>
          (line.lineKind ?? "principal") === "principal"
            ? [
                {
                  stableOrderId: `order-${n}`,
                  stableLineId: `line-${n}-${i}`,
                  resolution: {
                    kind: "existing",
                    productId: line.product ?? baseRow!.shortcode,
                  },
                },
              ]
            : [],
        ),
      }),
      ctx.actor,
    );
    // The run is finalized by the agent in production; the apply gate needs a
    // finished run, so mirror that terminal state here.
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review" })
      .where(eq(runTable.id, started.run.id));
    const [target] = await getDb(ctx.db)
      .select({ id: runTarget.id, diff: runTarget.diff })
      .from(runTarget)
      .where(eq(runTarget.runId, started.run.id));
    return {
      n,
      party,
      livePurchase,
      liveExpenses,
      run: started.run,
      validation,
      allocationId,
      targetDiff: () =>
        getDb(ctx.db)
          .select({
            state: runTarget.state,
            outcome: runTarget.outcome,
            warning: runTarget.warning,
            diff: runTarget.diff,
          })
          .from(runTarget)
          .where(eq(runTarget.id, target!.id))
          .then(([row]) => row!),
      get diff() {
        return validationDiff.parse(target!.diff);
      },
      apply: async (ids: string[], operationId = `apply:${n}`) =>
        (
          await applyValidationCorrections(
            ctx.db,
            applyValidationCorrectionsInput.parse({
              runId: started.run.publicId,
              purchaseId: livePurchase.shortcode,
              operationId,
              correctionIds: ids,
            }),
            ctx.actor,
          )
        ).result,
    };
  };

  const liveRows = async (purchaseId: PurchaseId) =>
    getDb(ctx.db)
      .select({
        shortcode: expense.shortcode,
        name: expense.name,
        cost: expense.cost,
        lineKind: expense.lineKind,
        productId: expense.productId,
        productQuantity: expense.productQuantity,
      })
      .from(expense)
      .where(and(eq(expense.purchaseId, purchaseId), isNull(expense.deletedAt)))
      .orderBy(expense.name, expense.cost);

  const allocations = async () =>
    getDb(ctx.db)
      .select({
        id: financialTransactionAllocation.id,
        purchaseId: financialTransactionAllocation.purchaseId,
        amount: financialTransactionAllocation.amount,
        deletedAt: financialTransactionAllocation.deletedAt,
      })
      .from(financialTransactionAllocation);

  it("records versioned field-level corrections and none for a foreign-currency plan or raw evidence drift", async () => {
    const drift = await scenario({
      live: [{ name: "Widget", cost: 10 }],
      plan: [
        { title: "Widget", amount: 12 },
        { title: "Gadget", amount: 3 },
      ],
      planStatedTotal: 15,
    });
    expect(drift.validation.targets[0]?.outcome).toBe("semantic_drift");
    expect(drift.diff.version).toBe(2);
    const kinds = drift.diff.corrections.map((c) => c.kind).sort();
    expect(kinds).toEqual([
      "expense_add",
      "expense_field",
      "purchase_stated_total",
    ]);
    expect(drift.diff.actual.currency).toBe("USD");

    const foreign = await scenario({
      live: [{ name: "Widget", cost: 10 }],
      plan: [{ title: "Widget", amount: 10 }],
      currency: "EUR",
    });
    expect(foreign.validation.targets[0]?.outcome).toBe("semantic_drift");
    expect(foreign.diff.corrections).toEqual([]);
    expect(foreign.diff.notes.length).toBeGreaterThan(0);

    const raw = await scenario({
      live: [{ name: "Widget", cost: 10 }],
      plan: [{ title: "Widget", amount: 10 }],
      sourceChecksum: checksum("d"),
    });
    expect(raw.validation.targets[0]).toMatchObject({
      outcome: "raw_evidence_drift",
      diff: null,
    });
    expect((await raw.targetDiff()).diff).toBeNull();
  });

  it("applies a partial selection atomically, leaves settlement untouched, and finishes in a second pass", async () => {
    const s = await scenario({
      live: [
        { name: "Widget", cost: 10 },
        { name: "Surplus", cost: 4 },
      ],
      plan: [
        { title: "Widget", amount: 12 },
        { title: "Gadget", amount: 3 },
      ],
      liveStatedTotal: 14,
      planStatedTotal: 15,
      withAllocation: true,
    });
    const allocationsBefore = await allocations();
    const widget = s.liveExpenses[0]!;
    const ids = Object.fromEntries(s.diff.corrections.map((c) => [c.id, c]));
    const amountId = `expense:${widget.shortcode}:amount`;
    expect(ids[amountId]).toBeDefined();

    const first = await s.apply([amountId, "purchase:statedTotal"]);
    expect(first).toMatchObject({
      status: "applied",
      outcome: "semantic_drift",
    });
    const afterFirst = await liveRows(s.livePurchase.id);
    expect(afterFirst.map((r) => [r.name, r.cost])).toEqual([
      ["Surplus", 4],
      ["Widget", 12],
    ]);
    const [purchaseRow] = await getDb(ctx.db)
      .select({ statedTotal: purchase.statedTotal })
      .from(purchase)
      .where(eq(purchase.id, s.livePurchase.id));
    expect(purchaseRow?.statedTotal).toBe(15);
    const partial = await s.targetDiff();
    expect(partial.state).toBe("unresolved");
    const remaining = validationDiff.parse(partial.diff).corrections;
    expect(remaining.map((c) => c.kind).sort()).toEqual([
      "expense_add",
      "expense_remove",
    ]);

    const second = await s.apply(
      remaining.map((c) => c.id),
      `apply:${s.n}:rest`,
    );
    expect(second).toMatchObject({ status: "applied", outcome: "replayed" });
    const done = await liveRows(s.livePurchase.id);
    expect(done.map((r) => [r.name, r.cost])).toEqual([
      ["Gadget", 3],
      ["Widget", 12],
    ]);
    expect(await s.targetDiff()).toMatchObject({
      state: "completed",
      outcome: "replayed",
      diff: null,
    });
    expect(await allocations()).toEqual(allocationsBefore);
    // Removal is a soft delete and the writes are audited under the run.
    const removed = await getDb(ctx.db)
      .select({ deletedAt: expense.deletedAt })
      .from(expense)
      .where(eq(expense.purchaseId, s.livePurchase.id));
    expect(removed.filter((r) => r.deletedAt !== null)).toHaveLength(1);
    const audits = await getDb(ctx.db)
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.runId, s.run.id));
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses with raw diagnostics when a live Expense changed after validation, writing nothing", async () => {
    const s = await scenario({
      live: [{ name: "Widget", cost: 10 }],
      plan: [{ title: "Widget", amount: 12 }],
      planStatedTotal: 12,
    });
    const widget = s.liveExpenses[0]!;
    await getDb(ctx.db)
      .update(expense)
      .set({ productQuantity: 2 })
      .where(eq(expense.id, widget.id));
    const amountResult = await s.apply(
      [`expense:${widget.shortcode}:amount`],
      `apply:${s.n}:b`,
    );
    expect(amountResult).toMatchObject({
      status: "stale",
      stale: [{ reason: expect.stringContaining("fingerprint") }],
    });
    const [row] = await liveRows(s.livePurchase.id);
    expect(row).toMatchObject({ productQuantity: 2, cost: 10 });
    const [purchaseRow] = await getDb(ctx.db)
      .select({ statedTotal: purchase.statedTotal })
      .from(purchase)
      .where(eq(purchase.id, s.livePurchase.id));
    expect(purchaseRow?.statedTotal).toBe(10);
  });

  it("refuses when the Purchase total moved or the Purchase was deleted", async () => {
    const moved = await scenario({
      live: [{ name: "Widget", cost: 10 }],
      plan: [{ title: "Widget", amount: 10 }],
      planStatedTotal: 11,
    });
    await getDb(ctx.db)
      .update(purchase)
      .set({ statedTotal: 99 })
      .where(eq(purchase.id, moved.livePurchase.id));
    expect((await moved.apply(["purchase:statedTotal"])).status).toBe("stale");

    const deleted = await scenario({
      live: [{ name: "Widget", cost: 10 }],
      plan: [{ title: "Widget", amount: 10 }],
      planStatedTotal: 11,
    });
    await getDb(ctx.db)
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(eq(purchase.id, deleted.livePurchase.id));
    const refused = await deleted.apply(["purchase:statedTotal"]);
    expect(refused).toMatchObject({ status: "stale" });
    expect(
      refused.status === "stale" ? refused.stale[0]?.reason : "",
    ).toContain("deleted");
  });

  it("pairs identical duplicate lines by multiplicity and adds only the missing copy", async () => {
    const s = await scenario({
      live: [{ name: "Widget", cost: 10 }],
      plan: [
        { title: "Widget", amount: 10 },
        { title: "Widget", amount: 10 },
      ],
      liveStatedTotal: 10,
      planStatedTotal: 20,
    });
    expect(s.diff.corrections.map((c) => c.kind).sort()).toEqual([
      "expense_add",
      "purchase_stated_total",
    ]);
    const add = s.diff.corrections.find((c) => c.kind === "expense_add")!;
    await s.apply([add.id, "purchase:statedTotal"]);
    expect(
      (await liveRows(s.livePurchase.id)).map((r) => [r.name, r.cost]),
    ).toEqual([
      ["Widget", 10],
      ["Widget", 10],
    ]);
  });

  it("never replaces an explicit Product and does not let a note be selected", async () => {
    const kept = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Explicitly assigned product" }),
      ctx.actor,
    );
    const other = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Plan resolves to another product" }),
      ctx.actor,
    );
    const [otherRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, other.entityId));
    const s = await scenario({
      live: [
        {
          name: "Widget",
          cost: 10,
          productId: kept.entityId,
          productQuantity: 1,
        },
      ],
      plan: [
        {
          title: "Widget",
          amount: 12,
          quantity: 1,
          product: otherRow!.shortcode,
        },
      ],
      planStatedTotal: 12,
    });
    const widget = s.liveExpenses[0]!;
    expect(s.diff.corrections.some((c) => c.field === "productId")).toBe(false);
    const note = s.diff.notes.find((n) => n.field === "productId");
    expect(note).toBeDefined();
    const refused = await s.apply([note!.id]);
    expect(refused.status).toBe("stale");
    await s.apply([`expense:${widget.shortcode}:amount`]);
    const [row] = await liveRows(s.livePurchase.id);
    expect(row).toMatchObject({ cost: 12, productId: kept.entityId });
  });

  it("fills a missing Product only when the plan resolves an existing one", async () => {
    const resolved = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Plan product for empty line" }),
      ctx.actor,
    );
    const [resolvedRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, resolved.entityId));
    const s = await scenario({
      live: [{ name: "Widget", cost: 10, productId: null }],
      plan: [
        {
          title: "Widget",
          amount: 10,
          quantity: 1,
          product: resolvedRow!.shortcode,
        },
      ],
      planStatedTotal: 10,
    });
    const ids = s.diff.corrections.map((c) => c.id);
    await s.apply(ids);
    const [row] = await liveRows(s.livePurchase.id);
    expect(row).toMatchObject({
      productId: resolved.entityId,
      productQuantity: 1,
    });
  });

  it("replays the same operation and refuses the same id with a different selection", async () => {
    const s = await scenario({
      live: [{ name: "Widget", cost: 10 }],
      plan: [
        { title: "Widget", amount: 10 },
        { title: "Gadget", amount: 2 },
      ],
      planStatedTotal: 12,
    });
    const add = s.diff.corrections.find((c) => c.kind === "expense_add")!;
    const first = await s.apply([add.id], "apply:replay");
    const second = await s.apply([add.id], "apply:replay");
    expect(second).toEqual(first);
    expect(await liveRows(s.livePurchase.id)).toHaveLength(2);
    await expect(
      s.apply(["purchase:statedTotal"], "apply:replay"),
    ).rejects.toThrow("different input");
    const operations = await getDb(ctx.db)
      .select({ kind: runOperation.kind })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, s.run.id),
          eq(runOperation.operationId, "apply:replay"),
        ),
      );
    expect(operations).toHaveLength(1);
  });

  it("rolls back every earlier write when a later correction violates an Expense invariant", async () => {
    const product1 = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Sign invariant product" }),
      ctx.actor,
    );
    const s = await scenario({
      live: [
        {
          name: "Widget",
          cost: 10,
          productId: product1.entityId,
          productQuantity: 1,
        },
      ],
      // A negative amount against a positive quantity violates the Expense
      // quantity/sign invariant, after the stated total was already written.
      plan: [{ title: "Widget", amount: -10, quantity: 1 }],
      planStatedTotal: -10,
    });
    const widget = s.liveExpenses[0]!;
    const selected = [
      "purchase:statedTotal",
      `expense:${widget.shortcode}:amount`,
    ];
    await expect(s.apply(selected)).rejects.toThrow(
      "its quantity cannot be positive",
    );
    const [purchaseRow] = await getDb(ctx.db)
      .select({ statedTotal: purchase.statedTotal })
      .from(purchase)
      .where(eq(purchase.id, s.livePurchase.id));
    expect(purchaseRow?.statedTotal).toBe(10);
    expect((await liveRows(s.livePurchase.id))[0]?.cost).toBe(10);
    const operations = await getDb(ctx.db)
      .select({ id: runOperation.id })
      .from(runOperation)
      .where(eq(runOperation.runId, s.run.id));
    expect(operations.map(() => 1).length).toBe(2); // prepare + validate only
  });
});

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ExpenseId,
  PurchaseId,
  PurchaseShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  unsafeExpenseShortcode,
  unsafeProductId,
  unsafeProjectShortcode,
  unsafePurchaseId,
  unsafePurchaseShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  type ExpenseCreateInput,
  type ExpenseOut,
  expenseCreateInput,
  expenseMatchInput,
  HOUSEHOLD_PROJECT_SHORTCODE,
  projectCreateInput,
} from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  householdDaysAgo,
  householdDaysFromNow,
  householdLocalDate,
} from "~/lib/household-date";
import type { Database } from "~/server/db";
import { expense as expenseTable, product, project } from "~/server/db/schema";
import { getAuditLog } from "~/server/repo/audit-log";
import { getDb } from "~/server/repo/database-helpers";
import { findOrphanedEntityEmbeddings } from "~/server/repo/entity-embedding";
import {
  createExpense,
  deleteExpenses,
  deleteExpensesWithPurchaseEffects,
  expenseAnalytics,
  expenseAnalyze,
  expenseFacetCounts,
  expenseList,
  expenseMonthlySummary,
  getExpenseByShortcode,
  matchExpenses,
  moveExpenses,
  setExpensesCostType,
  setExpensesTrade,
  updateExpense,
} from "~/server/repo/expense";
import { createProduct } from "~/server/repo/product";
import { createProject, deleteProjects } from "~/server/repo/project";
import {
  deletePurchases,
  getPurchaseByID,
  getPurchaseExpenses,
  purchaseList,
  updatePurchase,
} from "~/server/repo/purchase";
import {
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  resolveLiveShortcode,
  resolveShortcode,
} from "~/server/repo/shortcode-resolver";
import { vendorOptions } from "~/server/repo/vendor";
import {
  expenseAnalyticsWorkflow,
  expenseBulkMoveWorkflow,
  expenseChargeContextWorkflow,
  expenseChartDataWorkflow,
  expenseTradeAffinityWorkflow,
} from "~/server/workflows/expense.server";

const unwrap = async <T>(p: Promise<{ output: T }>): Promise<T> =>
  (await p).output;

const createExpenseWorkflowCaller = (db: Database, actor: ActorContext) => ({
  chartData: (input: Parameters<typeof expenseChartDataWorkflow>[1]) =>
    expenseChartDataWorkflow(db, input),
  analytics: (input: Parameters<typeof expenseAnalyticsWorkflow>[1]) =>
    expenseAnalyticsWorkflow(db, input),
  chargeContext: (input: Parameters<typeof expenseChargeContextWorkflow>[1]) =>
    expenseChargeContextWorkflow(db, input),
  tradeAffinity: () => expenseTradeAffinityWorkflow(db),
  bulkMove: (input: Parameters<typeof expenseBulkMoveWorkflow>[1]) =>
    expenseBulkMoveWorkflow(db, input, actor),
});

const vendorIdOf = (expense: ExpenseOut): VendorShortcode => {
  if (!expense.vendorId) {
    throw new Error(`expected a resolved vendor on "${expense.name}"`);
  }
  return expense.vendorId;
};

const purchaseIdOf = (expense: ExpenseOut): PurchaseShortcode => {
  if (!expense.purchaseId) {
    throw new Error(`expected a resolved charge on "${expense.name}"`);
  }
  return expense.purchaseId;
};

/** Folded purchases are tombstoned but must remain resolvable for assertions. */
const purchaseUuid = async (
  db: Database,
  code: PurchaseShortcode,
): Promise<PurchaseId> => {
  const resolved = await resolveShortcode(db, code);
  if (!resolved) throw new Error(`purchase not found: ${code}`);
  return unsafePurchaseId(resolved.id);
};

describe("expense repository — CRUD", () => {
  const ctx = withTestDb();

  it("creates, reads (with projectName join), updates (incl. clearing date/projectId), and deletes", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "expense crud project" }),
      ctx.actor,
    );

    const { output: created } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "test faucet",
        projectId: project.id,
        cost: 42.5,
        date: "2026-01-15",
        url: "https://example.com/faucet",
        notes: "brushed nickel",
        future: false,
      }),
      ctx.actor,
    );

    const read = await getExpenseByShortcode(ctx.db, created.id);
    expect(read).toMatchObject({
      name: "test faucet",
      cost: 42.5,
      date: "2026-01-15",
      costType: "materials",
      trade: "plumbing",
      url: "https://example.com/faucet",
      notes: "brushed nickel",
      future: false,
      projectId: project.id,
      projectName: project.name,
    });

    const { output: updated } = await updateExpense(
      ctx.db,
      created.id,
      { name: "updated faucet", cost: 55, projectId: null },
      ctx.actor,
    );
    expect(updated.name).toBe("updated faucet");
    expect(updated.cost).toBe(55);
    expect(updated.date).toBe("2026-01-15");
    expect(updated.projectId).toBeNull();
    expect(updated.projectName).toBeNull();

    await deleteExpenses(ctx.db, [created.id], ctx.actor);

    expect(await getExpenseByShortcode(ctx.db, created.id)).toBeNull();

    const { data } = await expenseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(data.map((p) => p.id)).not.toContain(created.id);
  });

  it("infers line roles once, honors explicit roles, audits changes, and protects product links", async () => {
    const { output: inferredTax, entityId: inferredTaxId } =
      await createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name: "Sales tax", cost: 26.81 }),
        ),
        ctx.actor,
      );
    expect(inferredTax.lineKind).toBe("tax");

    const explicitPrincipal = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name: "Sales tax", lineKind: "principal" }),
        ),
        ctx.actor,
      ),
    );
    expect(explicitPrincipal.lineKind).toBe("principal");

    const renamed = await unwrap(
      updateExpense(
        ctx.db,
        explicitPrincipal.id,
        { name: "Shipping" },
        ctx.actor,
      ),
    );
    expect(renamed.lineKind).toBe("principal");

    const productRow = await createProduct(
      ctx.db,
      makeProductInput({ name: "line role product" }),
      ctx.actor,
    );
    const productExpense = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name: "Tax", productId: productRow.id }),
        ),
        ctx.actor,
      ),
    );
    expect(productExpense.lineKind).toBe("principal");

    await expect(
      updateExpense(ctx.db, productExpense.id, { lineKind: "tax" }, ctx.actor),
    ).rejects.toMatchObject({
      cause: { reason: "CONSTRAINT_VIOLATION" },
    });
    expect(
      (await getExpenseByShortcode(ctx.db, productExpense.id))?.productId,
    ).toBe(productRow.id);

    await expect(
      updateExpense(
        ctx.db,
        inferredTax.id,
        { productId: productRow.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "CONSTRAINT_VIOLATION" },
    });
    expect(
      (await getExpenseByShortcode(ctx.db, inferredTax.id))?.productId,
    ).toBeNull();

    const changedKind = await unwrap(
      updateExpense(ctx.db, inferredTax.id, { lineKind: "fee" }, ctx.actor),
    );
    expect(changedKind.lineKind).toBe("fee");
    const audit = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: inferredTaxId,
      limit: 20,
    });
    expect(
      audit.entries.some(
        (entry) =>
          entry.action === "update" &&
          (
            entry.changes as {
              lineKind?: { from: unknown; to: unknown };
            } | null
          )?.lineKind?.from === "tax" &&
          (
            entry.changes as {
              lineKind?: { from: unknown; to: unknown };
            } | null
          )?.lineKind?.to === "fee",
      ),
    ).toBe(true);

    const discount = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name: "Order discount", cost: -60 }),
        ),
        ctx.actor,
      ),
    );
    const taxRefund = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: "Tax refund",
            cost: -8.5,
            lineKind: "tax",
          }),
        ),
        ctx.actor,
      ),
    );
    expect(discount.lineKind).toBe("discount");
    expect(taxRefund).toMatchObject({ lineKind: "tax", cost: -8.5 });
  });

  it("reports affected and newly empty Purchases while retaining sibling lines", async () => {
    const { output: retained } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "retained purchase line",
          vendor: "Deletion Outcome Vendor",
          orderId: "DELETE-OUTCOME-1",
        }),
      ),
      ctx.actor,
    );
    const { output: sibling } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "deleted sibling line",
          vendor: "Deletion Outcome Vendor",
          orderId: "DELETE-OUTCOME-1",
        }),
      ),
      ctx.actor,
    );
    const { output: only } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "deleted only line",
          vendor: "Deletion Outcome Vendor",
          orderId: "DELETE-OUTCOME-2",
        }),
      ),
      ctx.actor,
    );

    const result = await deleteExpensesWithPurchaseEffects(
      ctx.db,
      [sibling.id, only.id],
      ctx.actor,
    );

    expect(result.result).toEqual({
      deleted: 2,
      deletedIds: expect.arrayContaining([sibling.id, only.id]),
      affectedPurchaseIds: expect.arrayContaining([
        retained.purchaseId,
        only.purchaseId,
      ]),
      newlyEmptyPurchaseIds: [only.purchaseId],
    });
    expect(await getExpenseByShortcode(ctx.db, retained.id)).not.toBeNull();
    expect(await getExpenseByShortcode(ctx.db, sibling.id)).toBeNull();
    expect(await getExpenseByShortcode(ctx.db, only.id)).toBeNull();
  });
});

describe("expense repository — expenseList filters", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("filters by search, costType, trade, future", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "plumbing",
        costType: "materials",
        name: "copper pipe",
        future: false,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "electrical",
        costType: "tools",
        name: "wire strippers",
        future: true,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "plumbing",
        costType: "services",
        name: "plumber visit",
        future: false,
      }),
      ctx.actor,
    );

    const bySearch = await expenseList(
      ctx.db,
      { search: "copper" },
      [],
      pagination,
    );
    expect(bySearch.data.map((p) => p.name)).toEqual(["copper pipe"]);

    const byCostType = await expenseList(
      ctx.db,
      { costType: "tools" },
      [],
      pagination,
    );
    expect(byCostType.data.map((p) => p.name)).toEqual(["wire strippers"]);

    const byTrade = await expenseList(
      ctx.db,
      { trade: "plumbing" },
      [],
      pagination,
    );
    expect(new Set(byTrade.data.map((p) => p.name))).toEqual(
      new Set(["copper pipe", "plumber visit"]),
    );

    const futureOnly = await expenseList(
      ctx.db,
      { future: true },
      [],
      pagination,
    );
    expect(futureOnly.data.map((p) => p.name)).toEqual(["wire strippers"]);

    const notFuture = await expenseList(
      ctx.db,
      { future: false },
      [],
      pagination,
    );
    expect(new Set(notFuture.data.map((p) => p.name))).toEqual(
      new Set(["copper pipe", "plumber visit"]),
    );
  });

  it("filters and sorts by line kind", async () => {
    for (const [name, lineKind] of [
      ["role principal", "principal"],
      ["role shipping", "shipping"],
      ["role tax", "tax"],
    ] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name, lineKind, date: "2026-02-01" }),
        ),
        ctx.actor,
      );
    }

    const filtered = await expenseList(
      ctx.db,
      { search: "role", lineKind: ["tax", "shipping"] },
      [],
      pagination,
    );
    expect(new Set(filtered.data.map((row) => row.lineKind))).toEqual(
      new Set(["tax", "shipping"]),
    );

    const sorted = await expenseList(
      ctx.db,
      { search: "role" },
      [{ orderBy: "lineKind", direction: "asc" }],
      pagination,
    );
    expect(sorted.data.map((row) => row.lineKind)).toEqual([
      "principal",
      "shipping",
      "tax",
    ]);
  });

  it("filters by line basis, and keeps purchase-less rows in the item_line bucket", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "basis deposit",
          lineBasis: "allocation",
          vendor: "Basis Vendor",
          orderId: "BASIS-1",
          date: "2026-03-01",
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "basis widget",
          vendor: "Basis Vendor",
          orderId: "BASIS-1",
          date: "2026-03-01",
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "basis unattached", date: "2026-03-01" }),
      ),
      ctx.actor,
    );

    const itemLines = await expenseList(
      ctx.db,
      { search: "basis", lineBasis: ["item_line"] },
      [],
      pagination,
    );
    expect(new Set(itemLines.data.map((row) => row.name))).toEqual(
      new Set(["basis widget", "basis unattached"]),
    );
    expect(itemLines.count).toBe(2);

    const allocations = await expenseList(
      ctx.db,
      { search: "basis", lineBasis: ["allocation"] },
      [],
      pagination,
    );
    expect(allocations.data.map((row) => row.name)).toEqual(["basis deposit"]);
    expect(allocations.count).toBe(1);

    const unfiltered = await expenseList(
      ctx.db,
      { search: "basis" },
      [],
      pagination,
    );
    expect(unfiltered.count).toBe(3);
  });

  it("refuses to link a Product to an allocation Expense", async () => {
    const productRow = await createProduct(
      ctx.db,
      makeProductInput({ name: "allocation guard product" }),
      ctx.actor,
    );

    // An allocation is a slice of an un-itemized total, so it buys no
    // particular item. Linking one would halve the product's derived unit
    // price (sum(cost)/sum(productQuantity) over every linked expense) while
    // also claiming an extra unit — see the pricing engine's aggregate.
    await expect(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: "allocation with product",
            lineBasis: "allocation",
            productId: productRow.id,
          }),
        ),
        ctx.actor,
      ),
    ).rejects.toThrow(/allocation Expense may not link a Product/);

    const linked = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: "item line with product",
            productId: productRow.id,
          }),
        ),
        ctx.actor,
      ),
    );
    expect(linked.productId).not.toBeNull();

    // The same guard on the update path: flipping an already-linked row to
    // `allocation` must fail rather than silently orphan the product link.
    await expect(
      updateExpense(ctx.db, linked.id, { lineBasis: "allocation" }, ctx.actor),
    ).rejects.toThrow(/allocation Expense may not link a Product/);
  });

  it("filters by projectId, and projectId + includeSubProjects over a 3-level chain", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "filter parent" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "filter child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );
    const { output: grandchild } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "filter grandchild",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );
    const { output: other } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "unrelated project" }),
      ctx.actor,
    );

    for (const [proj, name] of [
      [parent, "parent expense"],
      [child, "child expense"],
      [grandchild, "grandchild expense"],
      [other, "unrelated expense"],
    ] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "materials",
          name,
          projectId: proj.id,
        }),
        ctx.actor,
      );
    }

    const directOnly = await expenseList(
      ctx.db,
      { projectId: parent.id },
      [],
      pagination,
    );
    expect(directOnly.data.map((p) => p.name)).toEqual(["parent expense"]);

    const subtree = await expenseList(
      ctx.db,
      { projectId: parent.id, includeSubProjects: true },
      [],
      pagination,
    );
    expect(new Set(subtree.data.map((p) => p.name))).toEqual(
      new Set(["parent expense", "child expense", "grandchild expense"]),
    );
    expect(subtree.data.map((p) => p.name)).not.toContain("unrelated expense");
  });

  it("filters by dateFrom/dateTo with inclusive boundaries", async () => {
    const { output: inWindow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "in window",
        date: "2026-02-15",
      }),
      ctx.actor,
    );
    const { output: lowerBoundary } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "on lower boundary",
        date: "2026-02-01",
      }),
      ctx.actor,
    );
    const { output: upperBoundary } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "on upper boundary",
        date: "2026-02-28",
      }),
      ctx.actor,
    );
    const { output: beforeWindow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "before window",
        date: "2026-01-01",
      }),
      ctx.actor,
    );
    const { output: afterWindow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "after window",
        date: "2026-03-01",
      }),
      ctx.actor,
    );
    const windowed = await expenseList(
      ctx.db,
      { dateFrom: "2026-02-01", dateTo: "2026-02-28" },
      [],
      pagination,
    );
    expect(new Set(windowed.data.map((p) => p.id))).toEqual(
      new Set([inWindow.id, lowerBoundary.id, upperBoundary.id]),
    );
    expect(windowed.data.map((p) => p.id)).not.toContain(beforeWindow.id);
    expect(windowed.data.map((p) => p.id)).not.toContain(afterWindow.id);

    const fromOnly = await expenseList(
      ctx.db,
      { dateFrom: "2026-02-28" },
      [],
      pagination,
    );
    expect(new Set(fromOnly.data.map((p) => p.id))).toEqual(
      new Set([upperBoundary.id, afterWindow.id]),
    );

    const toOnly = await expenseList(
      ctx.db,
      { dateTo: "2026-02-01" },
      [],
      pagination,
    );
    expect(new Set(toOnly.data.map((p) => p.id))).toEqual(
      new Set([beforeWindow.id, lowerBoundary.id]),
    );
  });

  it("resolves stable relative date filters against the household day", async () => {
    const createDated = (name: string, date: string) =>
      createExpense(
        ctx.db,
        expenseCreateInput.parse({
          trade: "other",
          costType: "materials",
          name,
          date,
        }),
        ctx.actor,
      );
    const past = await createDated("relative past", householdDaysAgo(1));
    const today = await createDated("relative today", householdLocalDate());
    const future = await createDated(
      "relative future",
      householdDaysFromNow(1),
    );

    const before = await expenseList(
      ctx.db,
      { dateRelative: "beforeToday" },
      [],
      pagination,
    );
    expect(before.data.map((row) => row.id)).toContain(past.output.id);
    expect(before.data.map((row) => row.id)).not.toContain(today.output.id);
    expect(before.data.map((row) => row.id)).not.toContain(future.output.id);

    const throughToday = await expenseList(
      ctx.db,
      { dateRelative: "onOrBeforeToday" },
      [],
      pagination,
    );
    expect(throughToday.data.map((row) => row.id)).toContain(past.output.id);
    expect(throughToday.data.map((row) => row.id)).toContain(today.output.id);
    expect(throughToday.data.map((row) => row.id)).not.toContain(
      future.output.id,
    );
  });

  it("filters by costMin/costMax (inclusive boundary, outside window, null-cost excluded)", async () => {
    const mk = (name: string, cost: number | undefined) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse({
            date: "2024-01-15",
            trade: "other",
            costType: "materials",
            name,
            ...(cost === undefined ? {} : { cost }),
          }),
          ctx.actor,
        ),
      );

    const lowerBoundary = await mk("cost on lower boundary", 100);
    const inWindow = await mk("cost in window", 250);
    const upperBoundary = await mk("cost on upper boundary", 500);
    const belowWindow = await mk("cost below window", 99.99);
    const aboveWindow = await mk("cost above window", 500.01);
    const credit = await mk("cost credit", -96.67);
    const zero = await mk("cost zero", 0);
    const nullCost = await mk("cost not recorded", undefined);
    expect(nullCost.cost).toBeNull();

    const windowed = await expenseList(
      ctx.db,
      { costMin: 100, costMax: 500 },
      [],
      pagination,
    );
    expect(new Set(windowed.data.map((p) => p.id))).toEqual(
      new Set([lowerBoundary.id, inWindow.id, upperBoundary.id]),
    );
    // Null cost falls out of the window by SQL semantics, exactly as a null
    // date does — `costPresenceFilter: "none"` is the filter for those rows.
    expect(windowed.data.map((p) => p.id)).not.toContain(nullCost.id);
    expect(windowed.data.map((p) => p.id)).not.toContain(belowWindow.id);
    expect(windowed.data.map((p) => p.id)).not.toContain(aboveWindow.id);

    const fromOnly = await expenseList(
      ctx.db,
      { costMin: 500 },
      [],
      pagination,
    );
    expect(new Set(fromOnly.data.map((p) => p.id))).toEqual(
      new Set([upperBoundary.id, aboveWindow.id]),
    );

    const toOnly = await expenseList(ctx.db, { costMax: 0 }, [], pagination);
    expect(new Set(toOnly.data.map((p) => p.id))).toEqual(
      new Set([credit.id, zero.id]),
    );

    // The guard-style regression: `costMin: 0` is a real bound, not a falsy
    // no-op. A truthiness check here would return the credit row too.
    const nonNegative = await expenseList(
      ctx.db,
      { costMin: 0 },
      [],
      pagination,
    );
    expect(nonNegative.data.map((p) => p.id)).not.toContain(credit.id);
    expect(nonNegative.data.map((p) => p.id)).toContain(zero.id);

    // ...and `costMax: 0` likewise excludes every positive row rather than
    // being dropped as falsy.
    expect(toOnly.data.map((p) => p.id)).not.toContain(inWindow.id);

    // Exit worklists require strictly negative money: zero-dollar corrections
    // are neither a credit nor a disposal candidate.
    const negative = await expenseList(
      ctx.db,
      { costSign: "negative" },
      [],
      pagination,
    );
    expect(negative.data.map((p) => p.id)).toEqual([credit.id]);
    const positive = await expenseList(
      ctx.db,
      { costSign: "positive" },
      [],
      pagination,
    );
    expect(new Set(positive.data.map((p) => p.id))).toEqual(
      new Set([
        lowerBoundary.id,
        inWindow.id,
        upperBoundary.id,
        belowWindow.id,
        aboveWindow.id,
      ]),
    );
  });

  it("filters and sorts by recorded product quantity with nulls last", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "quantity filter product" }),
      ctx.actor,
    );
    const mk = (name: string, productQuantity: number | null) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse({
            date: "2024-01-15",
            trade: "other",
            costType: "materials",
            name,
            productId: product.id,
            productQuantity,
          }),
          ctx.actor,
        ),
      );

    const unknown = await mk("quantity unknown", null);
    const one = await mk("quantity one", 1);
    const two = await mk("quantity two", 2);
    const five = await mk("quantity five", 5);

    const exact = await expenseList(
      ctx.db,
      { productQuantityMin: 1, productQuantityMax: 1 },
      [],
      pagination,
    );
    expect(exact.data.map((row) => row.id)).toEqual([one.id]);

    const has = await expenseList(
      ctx.db,
      { productQuantityPresenceFilter: "has", productQuantityMin: 2 },
      [],
      pagination,
    );
    expect(new Set(has.data.map((row) => row.id))).toEqual(
      new Set([two.id, five.id]),
    );

    const missing = await expenseList(
      ctx.db,
      { productQuantityPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(missing.data.map((row) => row.id)).toEqual([unknown.id]);

    const asc = await expenseList(
      ctx.db,
      {},
      [{ orderBy: "productQuantity", direction: "asc" }],
      pagination,
    );
    expect(asc.data.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      five.id,
      unknown.id,
    ]);

    const desc = await expenseList(
      ctx.db,
      {},
      [{ orderBy: "productQuantity", direction: "desc" }],
      pagination,
    );
    expect(desc.data.map((row) => row.id)).toEqual([
      five.id,
      two.id,
      one.id,
      unknown.id,
    ]);
  });

  it("round-trips a signed quantity, and refuses the two shapes that make no sense", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "signed quantity product" }),
      ctx.actor,
    );
    const mk = (data: Record<string, unknown>) =>
      createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2026-06-03",
          trade: "other",
          costType: "materials",
          productId: product.id,
          ...data,
        }),
        ctx.actor,
      );

    // A $0 discard: the negative quantity is the whole signal that a unit left.
    const discard = await unwrap(
      mk({ name: "Discarded — thing", cost: 0, productQuantity: -1 }),
    );
    expect(discard.productQuantity).toBe(-1);

    const freebie = await unwrap(
      mk({ name: "promo pack", cost: 0, productQuantity: 1 }),
    );
    const corrected = await unwrap(
      updateExpense(ctx.db, freebie.id, { productQuantity: -1 }, ctx.actor),
    );
    expect(corrected.productQuantity).toBe(-1);

    // Zero is legal in exactly one direction: money back with no unit moved,
    // which is a price concession (Amazon "Account adjustment"). Admitted to
    // the CHECK in 2026-08 so that class could stop borrowing `null` and being
    // counted as an unrecorded quantity.
    const concession = await unwrap(
      mk({ name: "price concession", cost: -20, productQuantity: 0 }),
    );
    expect(concession.productQuantity).toBe(0);

    // On a $0 line it says nothing at all, on a positive-cost line it would be a
    // fee or an allocation, and on an unclassified line the money's direction is
    // not known yet — none may carry a zero. All three are the repo guard's job;
    // the zod schema cannot see `cost`, so it deliberately no longer carries a
    // bare `!== 0` refinement.
    await expect(
      mk({ name: "zero units on a free line", cost: 0, productQuantity: 0 }),
    ).rejects.toThrow();
    await expect(
      mk({ name: "zero units on a buy", cost: 10, productQuantity: 0 }),
    ).rejects.toThrow();
    await expect(
      mk({ name: "zero units, cost unknown", cost: null, productQuantity: 0 }),
    ).rejects.toThrow();

    // And the CHECK backstops the unclassified case specifically. This is the
    // three-valued-logic trap the constraint's first version fell into: without
    // the `cost IS NOT NULL` guard, `NULL < 0` is NULL, `(0 <> 0 OR NULL)` is
    // NULL, and a CHECK admits anything that is not FALSE. Asserting through raw
    // SQL is the point — it bypasses the repo guard above, so this fails if the
    // constraint alone regresses.
    await expect(
      getDb(ctx.db)
        .update(expenseTable)
        .set({ cost: null, productQuantity: 0 })
        .where(eq(expenseTable.shortcode, concession.id)),
    ).rejects.toThrow();

    // ...and the DB CHECK is the backstop under it. This assertion is the one
    // that fails loudly if someone edits the `check(...)` in schema.ts and
    // assumes `db:push` shipped it — `drizzle-kit push` does not diff CHECK
    // constraints, so the test template would carry a constraint production
    // lacks (or vice versa) with nothing else to notice. `discard` is a $0
    // line, so zeroing its quantity must still be refused at the DB.
    await expect(
      getDb(ctx.db)
        .update(expenseTable)
        .set({ productQuantity: 0 })
        .where(eq(expenseTable.shortcode, discard.id)),
    ).rejects.toThrow();

    // A positive cost is an acquisition, so a negative quantity there says
    // nothing and would only corrupt the derived-price aggregate. Rejected by
    // the repo guard, not the constraint.
    await expect(
      mk({ name: "bought negative?", cost: 10, productQuantity: -2 }),
    ).rejects.toThrow();
  });

  it("ORs several `search` terms over the name, and ANDs notesSearch/urlSearch", async () => {
    const { output: extractor } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "dust extractor",
        notes: "festool order CT-36",
        url: "home depot",
      }),
      ctx.actor,
    );
    const { output: chopSaw } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "chop saw",
        notes: "bosch miter",
      }),
      ctx.actor,
    );
    const { output: unrelated } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "nursery mix",
      }),
      ctx.actor,
    );

    const single = await expenseList(
      ctx.db,
      { search: "extractor" },
      [],
      pagination,
    );
    expect(single.data.map((p) => p.id)).toEqual([extractor.id]);

    // Several terms OR — this is the whole point. The ledger names the thing,
    // not the product, so a caller guessing at synonyms wants any of them to
    // hit. ANDing would make this strictly worse than the single-term search.
    const either = await expenseList(
      ctx.db,
      { search: ["extractor", "chop"] },
      [],
      pagination,
    );
    expect(new Set(either.data.map((p) => p.id))).toEqual(
      new Set([extractor.id, chopSaw.id]),
    );
    expect(either.data.map((p) => p.id)).not.toContain(unrelated.id);

    const byNotes = await expenseList(
      ctx.db,
      { notesSearch: "festool" },
      [],
      pagination,
    );
    expect(byNotes.data.map((p) => p.id)).toEqual([extractor.id]);

    const nameAndNotes = await expenseList(
      ctx.db,
      { search: ["extractor", "chop"], notesSearch: "bosch" },
      [],
      pagination,
    );
    expect(nameAndNotes.data.map((p) => p.id)).toEqual([chopSaw.id]);

    const byUrl = await expenseList(
      ctx.db,
      { urlSearch: "home depot" },
      [],
      pagination,
    );
    expect(byUrl.data.map((p) => p.id)).toEqual([extractor.id]);

    const blank = await expenseList(ctx.db, { search: ["  "] }, [], pagination);
    expect(blank.data.map((p) => p.id)).toEqual(
      expect.arrayContaining([extractor.id, chopSaw.id, unrelated.id]),
    );
  });

  it("combines filters with AND semantics", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "combined filter project" }),
      ctx.actor,
    );
    const { output: matches } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "matches everything",
        projectId: project.id,
        date: "2026-05-10",
        future: false,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "electrical",
        costType: "materials",
        name: "wrong trade",
        projectId: project.id,
        date: "2026-05-10",
        future: false,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "wrong date",
        projectId: project.id,
        date: "2026-01-01",
        future: false,
      }),
      ctx.actor,
    );

    const result = await expenseList(
      ctx.db,
      {
        projectId: project.id,
        trade: "plumbing",
        costType: "materials",
        future: false,
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
      },
      [],
      pagination,
    );
    expect(result.data.map((p) => p.id)).toEqual([matches.id]);
  });
});

describe("expense repository — sorting/pagination", () => {
  const ctx = withTestDb();

  it("defaults to sorting by date, supports multi-sort, and reports correct total count with a small page size", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "b expense",
        cost: 10,
        date: "2026-01-02",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "an expense",
        cost: 20,
        date: "2026-01-01",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "an expense second",
        cost: 5,
        date: "2026-01-01",
      }),
      ctx.actor,
    );

    const byDate = await expenseList(
      ctx.db,
      {},
      [{ orderBy: "date", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(byDate.data[0]?.date).toBe("2026-01-01");
    expect(byDate.data[2]?.date).toBe("2026-01-02");

    const multiSort = await expenseList(
      ctx.db,
      {},
      [
        { orderBy: "date", direction: "asc" },
        { orderBy: "cost", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(multiSort.data.map((p) => p.name)).toEqual([
      "an expense",
      "an expense second",
      "b expense",
    ]);

    const { data: page, count } = await expenseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 2,
    });
    expect(page).toHaveLength(2);
    expect(count).toBe(3);
  });

  it("keeps tied sort values disjoint and exhaustive across the 100-row boundary", async () => {
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const shortcode = (value: number) => {
      let remaining = value;
      let body = "";
      for (let position = 0; position < 4; position += 1) {
        body = alphabet[remaining % alphabet.length]! + body;
        remaining = Math.floor(remaining / alphabet.length);
      }
      return `EXP-${body}`;
    };

    await getDb(ctx.db)
      .insert(expenseTable)
      .values(
        Array.from({ length: 105 }, (_, index) => ({
          shortcode: shortcode(index),
          name: `boundary expense ${index}`,
          date: "2026-03-24",
          costType: "materials" as const,
          trade: "other" as const,
        })),
      );

    const sort = [{ orderBy: "date", direction: "desc" as const }];
    const first = await expenseList(ctx.db, {}, sort, {
      pageIndex: 0,
      pageSize: 100,
    });
    const second = await expenseList(ctx.db, {}, sort, {
      pageIndex: 1,
      pageSize: 100,
    });
    const repeatedFirst = await expenseList(ctx.db, {}, sort, {
      pageIndex: 0,
      pageSize: 100,
    });

    const ids = [...first.data, ...second.data].map((row) => row.id);
    expect(first.count).toBe(105);
    expect(first.data).toHaveLength(100);
    expect(second.data).toHaveLength(5);
    expect(new Set(ids).size).toBe(105);
    expect(repeatedFirst.data.map((row) => row.id)).toEqual(
      first.data.map((row) => row.id),
    );
  });
});

describe("expense workflow", () => {
  const ctx = withTestDb();

  it("chartData returns the filtered set", async () => {
    const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "plumbing",
        costType: "materials",
        name: "chart match",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "electrical",
        costType: "materials",
        name: "chart non-match",
      }),
      ctx.actor,
    );

    const result = await caller.chartData({ trade: "plumbing" });
    expect(result.map((p) => p.name)).toEqual(["chart match"]);
  });

  describe("projectPresenceFilter", () => {
    const seedProjectMix = async () => {
      const [{ output: projA }, { output: projB }] = await Promise.all([
        createProject(
          ctx.db,
          projectCreateInput.parse({ name: "assigned home" }),
          ctx.actor,
        ),
        createProject(
          ctx.db,
          projectCreateInput.parse({ name: "other home" }),
          ctx.actor,
        ),
      ]);
      for (const [name, projectId] of [
        ["has a project", projA.id],
        ["other project", projB.id],
        ["needs a project", undefined],
      ] as const) {
        await createExpense(
          ctx.db,
          expenseCreateInput.parse({
            date: "2024-01-15",
            trade: "drywall",
            costType: "tools",
            name,
            ...(projectId ? { projectId } : {}),
          }),
          ctx.actor,
        );
      }
      return { projA, projB };
    };

    it("'none' returns only unassigned expenses", async () => {
      const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
      await seedProjectMix();

      const rows = await caller.chartData({ projectPresenceFilter: "none" });
      const names = rows.map((p) => p.name);
      expect(names).toContain("needs a project");
      expect(names).not.toContain("has a project");
      expect(names).not.toContain("other project");
    });

    it("'has' returns only assigned expenses", async () => {
      const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
      await seedProjectMix();

      const names = (
        await caller.chartData({ projectPresenceFilter: "has" })
      ).map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(["has a project", "other project"]),
      );
      expect(names).not.toContain("needs a project");
    });

    it("combines with projectId as OR — that project plus the unassigned", async () => {
      const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
      const { projA } = await seedProjectMix();

      const names = (
        await caller.chartData({
          projectId: [projA.id],
          projectPresenceFilter: "none",
        })
      ).map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(["has a project", "needs a project"]),
      );
      expect(names).not.toContain("other project");
    });

    // buildExpenseWhereClause backs BOTH the ledger list and the analytics
    // aggregates; this pins that they still agree through the new OR branch.
    it("keeps ledger totals and analytics totals in agreement", async () => {
      const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
      const { projA } = await seedProjectMix();
      const filters = {
        projectId: [projA.id],
        projectPresenceFilter: "none" as const,
      };

      const [listed, analytics] = await Promise.all([
        expenseList(ctx.db, filters, [], { pageIndex: 0, pageSize: 500 }),
        caller.analytics(filters),
      ]);

      expect(analytics.summary.count).toBe(listed.data.length);
      expect(analytics.summary.net).toBeCloseTo(
        listed.data.reduce((sum, p) => sum + (p.cost ?? 0), 0),
        2,
      );
    });
  });

  describe("chargeContext", () => {
    it("returns canonical charge identity and the other lines, excluding the expense itself", async () => {
      const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
      const orderId = "111-siblings-0000001";
      const [{ output: self }, { output: sibling }] = await Promise.all([
        createExpense(
          ctx.db,
          makeExpenseInput({
            name: "sibling source row",
            vendor: "Amazon",
            orderId,
          }),
          ctx.actor,
        ),
        createExpense(
          ctx.db,
          makeExpenseInput({
            name: "the other line",
            vendor: "Amazon",
            orderId,
          }),
          ctx.actor,
        ),
      ]);
      await createExpense(
        ctx.db,
        makeExpenseInput({ name: "unrelated amazon buy", vendor: "Amazon" }),
        ctx.actor,
      );

      // Charge date and ledger date are separate domain fields. The link label
      // must use this canonical Purchase date, never `self.date`.
      const chargeDate = "2026-07-30";
      await updatePurchase(
        ctx.db,
        purchaseIdOf(self),
        { date: chargeDate },
        ctx.actor,
      );

      const context = await caller.chargeContext(self.id);
      expect(context?.purchase).toEqual({
        id: purchaseIdOf(self),
        orderId,
        displayLabel: null,
        date: chargeDate,
        vendorId: vendorIdOf(self),
        vendorName: "Amazon",
      });
      expect(context?.siblings.map((p) => p.id)).toEqual([sibling.id]);
    });

    it("returns null for an expense with no charge — without early-returning on a missing order id", async () => {
      const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
      const { output: chargeless } = await createExpense(
        ctx.db,
        makeExpenseInput({ name: "cash, no vendor" }),
        ctx.actor,
      );
      expect(chargeless.purchaseId).toBeNull();
      expect(await caller.chargeContext(chargeless.id)).toBeNull();

      const { output: orderless } = await createExpense(
        ctx.db,
        makeExpenseInput({ name: "walk-in line a", vendor: "Tool Nirvana" }),
        ctx.actor,
      );
      const { output: alsoOnThatCharge } = await createExpense(
        ctx.db,
        makeExpenseInput({
          name: "walk-in line b",
          purchaseId: purchaseIdOf(orderless),
        }),
        ctx.actor,
      );
      expect(orderless.orderId).toBeNull();
      const context = await caller.chargeContext(orderless.id);
      expect(context?.purchase.orderId).toBeNull();
      expect(context?.purchase.vendorName).toBe("Tool Nirvana");
      expect(context?.siblings.map((p) => p.id)).toEqual([alsoOnThatCharge.id]);
    });
  });

  it("tradeAffinity counts assigned expenses per project and trade", async () => {
    const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
    const { output: proj } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "affinity project" }),
      ctx.actor,
    );
    for (const trade of ["drywall", "drywall", "electrical"] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade,
          costType: "materials",
          name: `affinity ${trade}`,
          projectId: proj.id,
        }),
        ctx.actor,
      );
    }
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "drywall",
        costType: "materials",
        name: "affinity unassigned",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "drywall",
        costType: "materials",
        lineKind: "tax",
        name: "affinity tax adjustment",
        projectId: proj.id,
      }),
      ctx.actor,
    );

    const matrix = await caller.tradeAffinity();
    const forProject = matrix.filter((row) => row.projectId === proj.id);
    expect(forProject.find((row) => row.trade === "drywall")?.count).toBe(2);
    expect(forProject.find((row) => row.trade === "electrical")?.count).toBe(1);
  });

  it("bulkMove moves expenses to another project and to the inbox (null), returning items + sideEffects", async () => {
    const caller = createExpenseWorkflowCaller(ctx.db, ctx.actor);
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "bulk move a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "bulk move b" }),
      ctx.actor,
    );
    const { output: p1 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "bulk move expense 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const { output: p2 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "bulk move expense 2",
        projectId: projectA.id,
      }),
      ctx.actor,
    );

    const toB = await caller.bulkMove({
      ids: [p1.id, p2.id],
      projectId: projectB.id,
    });
    expect(toB.items.map((i) => i.projectId)).toEqual([
      projectB.id,
      projectB.id,
    ]);
    expect(toB.sideEffects).toBeDefined();

    const toInbox = await caller.bulkMove({
      ids: [p1.id, p2.id],
      projectId: null,
    });
    expect(toInbox.items.every((i) => i.projectId === null)).toBe(true);
    expect(toInbox.sideEffects).toBeDefined();
  });
});

describe("expense repository — moveExpenses", () => {
  const ctx = withTestDb();

  it("moves rows to the new projectId and writes an audit entry per changed row", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses a" }),
      ctx.actor,
    );
    const { output: projectB, entityId: projectBId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses b" }),
      ctx.actor,
    );
    const { output: p1, entityId: p1Id } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "move me 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const { output: p2 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "move me 2",
        projectId: projectA.id,
      }),
      ctx.actor,
    );

    const moved = await moveExpenses(
      ctx.db,
      { ids: [p1.id, p2.id], projectId: projectB.id },
      ctx.actor,
    );
    expect(moved.map((p) => p.projectId)).toEqual([projectB.id, projectB.id]);

    // `getAuditLog`'s `entityId` matches the internal uuid, not the shortcode
    // — but the `projectId` FK diff `computeChanges` records IS resolved to
    // the public shortcode on read, same as `entityId`, so a raw uuid never
    // reaches an MCP payload (see `getAuditLog`'s `collectChangeRefs`/
    // `remapChangeShortcodes`, which derive the FK-ness of `projectId` from
    // `INCOMING_EDGES` rather than a second hand-kept list).
    const auditP1 = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: p1Id,
      limit: 20,
    });
    expect(
      auditP1.entries.some(
        (e) =>
          e.action === "update" &&
          (e.changes as { projectId?: { from: unknown; to: unknown } } | null)
            ?.projectId?.to === projectB.id,
      ),
    ).toBe(true);
    // And never the raw uuid the DB column actually stores.
    expect(
      auditP1.entries.some(
        (e) =>
          (e.changes as { projectId?: { from: unknown; to: unknown } } | null)
            ?.projectId?.to === projectBId,
      ),
    ).toBe(false);
  });

  it("leaves soft-deleted ids in the input untouched", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses untouched a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses untouched b" }),
      ctx.actor,
    );
    const { output: live } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "still live",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const { output: deleted } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "soon deleted",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    await deleteExpenses(ctx.db, [deleted.id], ctx.actor);

    const moved = await moveExpenses(
      ctx.db,
      { ids: [live.id, deleted.id], projectId: projectB.id },
      ctx.actor,
    );
    expect(moved.map((p) => p.id)).toEqual([live.id]);
  });

  it("rejects a nonexistent or soft-deleted target project with PROJECT_NOT_FOUND", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses reject source" }),
      ctx.actor,
    );
    const { output: expenseRow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "reject target",
        projectId: project.id,
      }),
      ctx.actor,
    );
    const bogusProjectId = unsafeProjectShortcode(
      "00000000-0000-0000-0000-000000000000",
    );

    await expect(
      moveExpenses(
        ctx.db,
        { ids: [expenseRow.id], projectId: bogusProjectId },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PROJECT_NOT_FOUND" },
    });

    const { output: deletedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "soon-deleted target" }),
      ctx.actor,
    );
    await deleteProjects(ctx.db, [deletedProject.id], ctx.actor);

    await expect(
      moveExpenses(
        ctx.db,
        { ids: [expenseRow.id], projectId: deletedProject.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PROJECT_NOT_FOUND" },
    });
  });

  it("no-op on an id list with only nonexistent ids (returns empty, no error)", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses noop project" }),
      ctx.actor,
    );
    const bogusId = unsafeExpenseShortcode("EXP-ZZZZ");

    const moved = await moveExpenses(
      ctx.db,
      { ids: [bogusId], projectId: project.id },
      ctx.actor,
    );
    expect(moved).toEqual([]);
  });
});

describe("expense repository — bulk trade / cost-type writes", () => {
  const ctx = withTestDb();

  const line = (name: string, overrides: Partial<ExpenseCreateInput> = {}) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput({ name, ...overrides })),
      ctx.actor,
    );

  const updateEntries = async (id: ExpenseId) =>
    (
      await getAuditLog(ctx.db, {
        entityType: "expense",
        entityId: id,
        limit: 50,
      })
    ).entries.filter((e) => e.action === "update");

  const changeOf = (
    entry: { changes: unknown } | undefined,
    field: "trade" | "costType",
  ) =>
    (entry?.changes as Record<string, { from: unknown; to: unknown }> | null)?.[
      field
    ];

  it("setExpensesTrade writes the trade over the listed ids only, and audits just the rows that changed", async () => {
    const { output: a, entityId: aId } = await line("bulk trade a", {
      trade: "other",
    });
    const { output: b } = await line("bulk trade b", { trade: "other" });
    // Already carries the target value: it must be written (harmlessly) but NOT
    // audited — `computeChanges` returns null, so the `if (changes)` arm skips it.
    const { output: already, entityId: alreadyId } = await line(
      "bulk trade already electrical",
      { trade: "electrical" },
    );
    const { output: untouched } = await line("bulk trade bystander", {
      trade: "plumbing",
    });

    const updated = await setExpensesTrade(
      ctx.db,
      { ids: [a.id, b.id, already.id], trade: "electrical" },
      ctx.actor,
    );

    expect(updated.map((row) => row.trade)).toEqual([
      "electrical",
      "electrical",
      "electrical",
    ]);
    expect((await getExpenseByShortcode(ctx.db, untouched.id))?.trade).toBe(
      "plumbing",
    );

    expect(changeOf((await updateEntries(aId))[0], "trade")).toEqual({
      from: "other",
      to: "electrical",
    });
    expect(await updateEntries(alreadyId)).toHaveLength(0);
  });

  it("setExpensesTrade skips soft-deleted ids and returns [] when nothing live matches", async () => {
    const { output: live } = await line("bulk trade live", { trade: "other" });
    const { output: deleted } = await line("bulk trade deleted", {
      trade: "other",
    });
    await deleteExpenses(ctx.db, [deleted.id], ctx.actor);

    const updated = await setExpensesTrade(
      ctx.db,
      { ids: [live.id, deleted.id], trade: "flooring" },
      ctx.actor,
    );
    expect(updated.map((row) => row.id)).toEqual([live.id]);

    // `before.length === 0` returns before any write, so an all-dead selection is
    // a silent no-op rather than an error.
    expect(
      await setExpensesTrade(
        ctx.db,
        { ids: [deleted.id], trade: "flooring" },
        ctx.actor,
      ),
    ).toEqual([]);
  });

  it("setExpensesCostType writes the cost type and audits only the changed rows", async () => {
    const { output: a, entityId: aId } = await line("bulk costType a", {
      costType: "materials",
    });
    const { output: already, entityId: alreadyId } = await line(
      "bulk costType already tools",
      { costType: "tools" },
    );

    const updated = await setExpensesCostType(
      ctx.db,
      { ids: [a.id, already.id], costType: "tools" },
      ctx.actor,
    );
    expect(updated.map((row) => row.costType)).toEqual(["tools", "tools"]);

    expect(changeOf((await updateEntries(aId))[0], "costType")).toEqual({
      from: "materials",
      to: "tools",
    });
    expect(await updateEntries(alreadyId)).toHaveLength(0);
  });
});

describe("expense repository — expenseAnalytics", () => {
  const ctx = withTestDb();

  it("aggregates match manual arithmetic, omits empty categories, and stays consistent with expenseList under the same filter", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analytics project a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analytics project b" }),
      ctx.actor,
    );

    const { output: p1 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "analytics p1 actual",
        projectId: projectA.id,
        cost: 100,
        date: "2026-01-10",
        future: false,
      }),
      ctx.actor,
    );
    const { output: p2 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2026-01-20",
        trade: "plumbing",
        costType: "materials",
        name: "analytics p2 committed",
        projectId: projectA.id,
        cost: 50,
        future: true,
      }),
      ctx.actor,
    );
    const { output: p3 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "electrical",
        costType: "materials",
        name: "analytics p3 credit",
        cost: -20,
        date: "2026-01-15",
        future: false,
      }),
      ctx.actor,
    );
    const { output: p4 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "electrical",
        costType: "services",
        name: "analytics p4 actual",
        projectId: projectB.id,
        cost: 30,
        date: "2026-02-01",
        future: false,
      }),
      ctx.actor,
    );
    const { output: p5 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "services",
        lineKind: "tax",
        name: "analytics p5 tax",
        projectId: projectA.id,
        cost: 23,
        date: "2026-01-10",
        future: false,
      }),
      ctx.actor,
    );
    const { output: p6 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "tools",
        lineKind: "discount",
        name: "analytics p6 discount",
        projectId: projectA.id,
        cost: -5,
        date: "2026-01-10",
        future: false,
      }),
      ctx.actor,
    );

    const filters = { search: "analytics p" };
    const result = await expenseAnalytics(ctx.db, filters);
    expect(await expenseMonthlySummary(ctx.db, filters)).toEqual(
      result.monthly,
    );

    expect(result.summary).toEqual({
      actual: 153,
      committed: 50,
      credits: 25,
      net: 178,
      count: 6,
      actualCount: 5,
      plannedCount: 1, // p2
    });
    expect(result.adjustments).toEqual({
      actual: 23,
      committed: 0,
      credits: 5,
      net: 18,
      count: 2,
    });

    // Dimensional analytics classify principal purchases only. The adjustment
    // rows deliberately carry different historical costType/trade values to
    // prove those values do not leak into the category matrices.
    expect(result.byCostType).toEqual(
      expect.arrayContaining([
        {
          costType: "materials",
          actual: 100,
          committed: 50,
          credits: 20,
          net: 130,
          count: 3,
        },
        {
          costType: "services",
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );
    expect(result.byCostType).toHaveLength(2);

    expect(result.byTrade).toEqual(
      expect.arrayContaining([
        {
          trade: "plumbing",
          actual: 100,
          committed: 50,
          credits: 0,
          net: 150,
          count: 2,
        },
        {
          trade: "electrical",
          actual: 30,
          committed: 0,
          credits: 20,
          net: 10,
          count: 2,
        },
      ]),
    );
    expect(result.byTrade).toHaveLength(2);

    expect(result.tradeCostMatrix).toHaveLength(3);
    expect(result.tradeCostMatrix).toEqual(
      expect.arrayContaining([
        {
          trade: "plumbing",
          costType: "materials",
          actual: 100,
          committed: 50,
          credits: 0,
          net: 150,
          count: 2,
        },
        {
          trade: "electrical",
          costType: "materials",
          actual: 0,
          committed: 0,
          credits: 20,
          net: -20,
          count: 1,
        },
        {
          trade: "electrical",
          costType: "services",
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );

    expect(result.monthly).toEqual([
      {
        month: "2026-01",
        actual: 123,
        committed: 50,
        credits: 25,
        net: 148,
        count: 5,
      },
      {
        month: "2026-02",
        actual: 30,
        committed: 0,
        credits: 0,
        net: 30,
        count: 1,
      },
    ]);

    expect(result.cumulative).toEqual([
      { month: "2026-01", cumulativeNet: 148 },
      { month: "2026-02", cumulativeNet: 178 },
    ]);

    expect(result.byProject).toEqual(
      expect.arrayContaining([
        {
          projectId: projectA.id,
          projectName: projectA.name,
          actual: 123,
          committed: 50,
          credits: 5,
          net: 168,
          count: 4,
        },
        {
          projectId: projectB.id,
          projectName: projectB.name,
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );
    expect(result.byProject).toHaveLength(2);

    // Analytics totals must agree with the visible ledger under the same filter.
    const { data: listedRows } = await expenseList(ctx.db, filters, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    expect(listedRows.map((p) => p.id).sort()).toEqual(
      [p1.id, p2.id, p3.id, p4.id, p5.id, p6.id].sort(),
    );
    const summedCost = listedRows.reduce((sum, p) => sum + (p.cost ?? 0), 0);
    expect(summedCost).toBe(result.summary.net);
  });

  it("groups byVendor through the charge, and does NOT sum to summary.net", async () => {
    const mk = (name: string, cost: number, vendor?: string) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse({
            trade: "other",
            costType: "tools",
            name,
            cost,
            future: false,
            date: "2026-04-01",
            ...(vendor ? { vendor } : {}),
          }),
          ctx.actor,
        ),
      );

    const acmeA = await mk("vendor acme a", 100, "Analytics Acme");
    const acmeB = await mk("vendor acme b", 25, "Analytics Acme");
    await mk("vendor acme refund", -25, "Analytics Acme");
    await mk("vendor other", 40, "Analytics Other");
    const vendorless = await mk("vendor none", 60);
    expect(vendorless.purchaseId).toBeNull();

    const result = await expenseAnalytics(ctx.db, { dateFrom: "2026-04-01" });

    const acme = result.byVendor.find((r) => r.vendorName === "Analytics Acme");
    expect(acme).toMatchObject({
      vendorId: vendorIdOf(acmeA),
      vendorName: "Analytics Acme",
      actual: 125,
      committed: 0,
      credits: 25,
      net: 100,
      count: 3,
    });
    expect(vendorIdOf(acmeB)).toBe(vendorIdOf(acmeA));

    expect(
      result.byVendor.find((r) => r.vendorName === "Analytics Other")?.net,
    ).toBe(40);
    expect(result.byVendor.map((r) => r.vendorName)).not.toContain(null);

    const vendorNet = result.byVendor.reduce((sum, r) => sum + r.net, 0);
    expect(vendorNet).toBe(140);
    expect(result.summary.net).toBe(200);
    expect(result.summary.net - vendorNet).toBe(60);
  });

  it("applies the same filters as expenseList (e.g. trade) so a scoped analytics call only sees the matching rows", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "plumbing",
        costType: "materials",
        name: "analytics filter match",
        cost: 10,
        future: false,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "electrical",
        costType: "materials",
        name: "analytics filter non-match",
        cost: 999,
        future: false,
      }),
      ctx.actor,
    );

    const result = await expenseAnalytics(ctx.db, {
      search: "analytics filter",
      trade: "plumbing",
    });
    expect(result.summary).toMatchObject({ net: 10, count: 1 });
    expect(result.byTrade).toEqual([
      {
        trade: "plumbing",
        actual: 10,
        committed: 0,
        credits: 0,
        net: 10,
        count: 1,
      },
    ]);
  });

  it("analyzes complete principal grids, reconciles the tail, compares the preceding inclusive range, and self-excludes facet filters", async () => {
    const create = (data: Parameters<typeof expenseCreateInput.parse>[0]) =>
      createExpense(ctx.db, expenseCreateInput.parse(data), ctx.actor);

    await create({
      date: "2026-06-01",
      trade: "plumbing",
      costType: "materials",
      name: "analyze complete current principal",
      cost: 120,
    });
    await create({
      date: "2026-06-02",
      trade: "other",
      costType: "services",
      lineKind: "tax",
      name: "analyze complete current adjustment",
      cost: 12,
    });
    await create({
      date: "2026-05-31",
      trade: "plumbing",
      costType: "materials",
      name: "analyze complete previous principal",
      cost: 80,
    });

    const filters = {
      search: "analyze complete",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-02",
    };
    const result = await expenseAnalyze(ctx.db, {
      filters,
      rowDimension: "trade",
      columnDimension: "costType",
      comparison: "previousPeriod",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready analyzer");
    expect(result.comparison.previousRange).toEqual({
      dateFrom: "2026-05-30",
      dateTo: "2026-05-31",
    });
    expect(result.cells).toEqual([
      expect.objectContaining({
        rowKey: "plumbing",
        columnKey: "materials",
        current: expect.objectContaining({ net: 120, count: 1 }),
        previous: expect.objectContaining({ net: 80, count: 1 }),
      }),
    ]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        key: "plumbing",
        filter: { lineKind: "principal", trade: "plumbing" },
      }),
    ]);
    expect(result.columns).toEqual([
      expect.objectContaining({
        key: "materials",
        filter: { lineKind: "principal", costType: "materials" },
      }),
    ]);
    // Trade/cost-type is deliberately principal-only, but the scope still
    // reports all money and the tail makes the excluded tax explicit.
    expect(result.totals.scope.current).toMatchObject({ net: 132, count: 2 });
    expect(result.totals.grid.current).toMatchObject({ net: 120, count: 1 });
    expect(result.reconciliation.tail.current).toMatchObject({
      net: 12,
      count: 1,
    });
    expect(result.reconciliation.causes.adjustments.current).toMatchObject({
      net: 12,
      count: 1,
    });

    const facets = await expenseFacetCounts(ctx.db, {
      filters: { ...filters, trade: "plumbing" },
      facetIds: ["trade", "lineKind"],
    });
    expect(
      facets.facets.find((facet) => facet.id === "trade")?.options,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "plumbing", count: 1 }),
        expect.objectContaining({ value: "other", count: 1 }),
      ]),
    );
    expect(
      facets.facets.find((facet) => facet.id === "lineKind")?.options,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "principal", count: 1 }),
      ]),
    );
  });

  it("reuses one-dimensional grouped rows as cells", async () => {
    const measured = await countTestDbQueries(() =>
      expenseAnalyze(ctx.db, {
        filters: { search: "one-dimensional query reuse" },
        rowDimension: "month",
        comparison: "none",
      }),
    );

    expect(measured.result.status).toBe("ready");
    expect(measured.queryCount).toBe(2);
  });

  it("keeps project/vendor omissions honest and emits exact month buckets", async () => {
    const { output: analyzerProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analyzer dimensions project" }),
      ctx.actor,
    );
    const linked = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse({
          name: "analyzer dimensions linked",
          date: "2026-07-15",
          trade: "other",
          costType: "services",
          projectId: analyzerProject.id,
          vendor: "Analyzer Dimensions Vendor",
          cost: 50,
        }),
        ctx.actor,
      ),
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "analyzer dimensions unattributed",
        date: "2026-07-16",
        trade: "other",
        costType: "services",
        cost: 20,
      }),
      ctx.actor,
    );
    const filters = { search: "analyzer dimensions" };

    const byProject = await expenseAnalyze(ctx.db, {
      filters,
      rowDimension: "project",
      comparison: "none",
    });
    expect(byProject.status).toBe("ready");
    if (byProject.status !== "ready") throw new Error("expected project rows");
    expect(byProject.rows).toEqual([
      expect.objectContaining({
        key: analyzerProject.id,
        filter: { project: analyzerProject.id },
      }),
    ]);
    expect(byProject.reconciliation.tail.current).toMatchObject({
      net: 20,
      count: 1,
    });
    expect(
      byProject.reconciliation.causes.unattributedProject.current,
    ).toMatchObject({ net: 20, count: 1 });
    expect(byProject.reconciliation.causes.adjustments.current).toMatchObject({
      net: 0,
      count: 0,
    });

    const byVendor = await expenseAnalyze(ctx.db, {
      filters,
      rowDimension: "vendor",
      comparison: "none",
    });
    expect(byVendor.status).toBe("ready");
    if (byVendor.status !== "ready") throw new Error("expected vendor rows");
    expect(byVendor.rows).toEqual([
      expect.objectContaining({
        key: vendorIdOf(linked),
        filter: { vendor: vendorIdOf(linked) },
      }),
    ]);
    expect(
      byVendor.reconciliation.causes.unattributedVendor.current,
    ).toMatchObject({ net: 20, count: 1 });

    const byMonth = await expenseAnalyze(ctx.db, {
      filters,
      rowDimension: "month",
      comparison: "none",
    });
    expect(byMonth.status).toBe("ready");
    if (byMonth.status !== "ready") throw new Error("expected month rows");
    expect(byMonth.rows).toEqual([
      expect.objectContaining({
        key: "2026-07",
        filter: { dateFrom: "2026-07-01", dateTo: "2026-07-31" },
      }),
    ]);

    const facets = await expenseFacetCounts(ctx.db, {
      filters,
      facetIds: ["project", "vendor"],
    });
    const projectOptions = facets.facets.find(
      (facet) => facet.id === "project",
    )?.options;
    expect(projectOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: analyzerProject.id,
          count: 1,
        }),
        expect.objectContaining({ value: "__any__", count: 1 }),
        expect.objectContaining({ value: "__none__", count: 1 }),
      ]),
    );
    const vendorOptions = facets.facets.find(
      (facet) => facet.id === "vendor",
    )?.options;
    expect(vendorOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: vendorIdOf(linked), count: 1 }),
        expect.objectContaining({ value: "__any__", count: 1 }),
        expect.objectContaining({ value: "__none__", count: 1 }),
      ]),
    );
  });
});

describe("expense repository — embedding cascade invariant", () => {
  const ctx = withTestDb();

  it("deleteExpenses leaves no orphaned EntityEmbedding rows", async () => {
    const { output: expenseRow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "embedding cascade check",
      }),
      ctx.actor,
    );

    await deleteExpenses(ctx.db, [expenseRow.id], ctx.actor);

    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });
});

// Money and ownership have separate authorities; negative lines record exits.
describe("expense repository — product bridge", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("round-trips productId/vendor and resolves productName", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge miter saw" }),
      ctx.actor,
    );

    const { output: created } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "millwork",
        costType: "tools",
        name: "miter saw",
        productId: product.id,
        vendor: "Home Depot",
        cost: 180,
      }),
      ctx.actor,
    );

    const read = await getExpenseByShortcode(ctx.db, created.id);
    expect(read).toMatchObject({
      productId: product.id,
      productName: "bridge miter saw",
      vendor: "Home Depot",
    });

    const { output: cleared } = await updateExpense(
      ctx.db,
      created.id,
      { productId: null, vendor: null },
      ctx.actor,
    );
    expect(cleared.productId).toBeNull();
    expect(cleared.productName).toBeNull();
    expect(cleared.vendor).toBeNull();
  });

  it("filters by productId — acquisition and disposal rows, nothing else", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge tile saw" }),
      ctx.actor,
    );

    const { output: bought } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "flooring",
        costType: "tools",
        name: "tile saw",
        productId: product.id,
        cost: 180,
      }),
      ctx.actor,
    );
    const { output: sold } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "flooring",
        costType: "tools",
        name: "sold tile saw",
        productId: product.id,
        cost: -150,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "flooring",
        costType: "materials",
        name: "unrelated thinset",
      }),
      ctx.actor,
    );

    const { data, count } = await expenseList(
      ctx.db,
      { productId: product.id },
      [],
      pagination,
    );
    expect(count).toBe(2);
    expect(data.map((p) => p.id).sort()).toEqual([bought.id, sold.id].sort());
    expect(data.reduce((sum, p) => sum + (p.cost ?? 0), 0)).toBe(30);
  });

  it("still matches name search when vendor is null", async () => {
    // Regression gate: vendor must never join the `search` term, because
    // buildSearchConditions ANDs its searchFilters — `name ILIKE q AND vendor
    // ILIKE q` would return nothing for the (overwhelming) null-vendor rows.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "vendorless grommets",
      }),
      ctx.actor,
    );

    const { data } = await expenseList(
      ctx.db,
      { search: "grommets" },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toContain("vendorless grommets");
  });

  it("filters by vendor id independently of search", async () => {
    const { output: lumber } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "lumber run",
        vendor: "Ganahl Lumber",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "screws",
        vendor: "Home Depot",
      }),
      ctx.actor,
    );

    const { data } = await expenseList(
      ctx.db,
      { vendorId: vendorIdOf(lumber) },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toEqual(["lumber run"]);
  });

  it("can't leak a vendor whose name is a prefix of another's", async () => {
    const { output: prime } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "prime order",
        vendor: "Amazon",
      }),
      ctx.actor,
    );
    const { output: business } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "bulk order",
        vendor: "Amazon Business",
      }),
      ctx.actor,
    );
    expect(vendorIdOf(prime)).not.toBe(vendorIdOf(business));

    const { data } = await expenseList(
      ctx.db,
      { vendorId: vendorIdOf(prime) },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toEqual(["prime order"]);
  });

  it("matches any of a set of vendor ids", async () => {
    const line = (name: string, vendor: string) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse({
            date: "2024-01-15",
            trade: "other",
            costType: "materials",
            name,
            vendor,
          }),
          ctx.actor,
        ),
      );
    const socketSet = await line("socket set", "eBay");
    const deckScrews = await line("deck screws", "Home Depot");
    await line("paint", "Lowe's");

    const { data } = await expenseList(
      ctx.db,
      { vendorId: [vendorIdOf(socketSet), vendorIdOf(deckScrews)] },
      [],
      pagination,
    );
    expect(data.map((p) => p.name).sort()).toEqual([
      "deck screws",
      "socket set",
    ]);
  });

  it("filters by purchase (charge) id directly, no vendor hop needed", async () => {
    const orderId = "111-purchaseid-filter-0000001";
    const { output: first } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "line one of the charge",
        vendor: "Amazon",
        orderId,
      }),
      ctx.actor,
    );
    const { output: second } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "line two of the charge",
        vendor: "Amazon",
        orderId,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "unrelated charge",
        vendor: "Home Depot",
      }),
      ctx.actor,
    );
    expect(purchaseIdOf(second)).toBe(purchaseIdOf(first));

    const { data } = await expenseList(
      ctx.db,
      { purchaseId: purchaseIdOf(first) },
      [],
      pagination,
    );
    expect(data.map((p) => p.name).sort()).toEqual([
      "line one of the charge",
      "line two of the charge",
    ]);
  });

  it("finds chargeless rows via vendorPresenceFilter, and ORs with a selection", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "cash at the yard",
      }),
      ctx.actor,
    );
    const { output: tileSaw } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "tile saw",
        vendor: "Tool Nirvana",
      }),
      ctx.actor,
    );

    const none = await expenseList(
      ctx.db,
      { vendorPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(none.data.map((p) => p.name)).toEqual(["cash at the yard"]);

    const both = await expenseList(
      ctx.db,
      { vendorId: vendorIdOf(tileSaw), vendorPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(both.data.map((p) => p.name).sort()).toEqual([
      "cash at the yard",
      "tile saw",
    ]);
  });
});

describe("expense repository — vendorId + vendorPresenceFilter OR guard", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("an unresolvable vendorId still ORs correctly with vendorPresenceFilter: none", async () => {
    // The vendor half must contribute `sql\`false\`` to the OR, not `undefined`
    // — otherwise dropping the vendor half entirely would let the presence
    // filter alone decide, silently discarding the fact that a specific
    // (bogus) vendor was also requested. Here the two vendorless rows below
    // are exactly what "none" should surface either way, so this pins that
    // combining an unresolvable id with a presence filter still narrows
    // correctly rather than only accidentally looking right because presence
    // alone would have produced the same set.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "widening guard no-vendor row",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "widening guard real-vendor row",
        vendor: "Widening Guard Vendor C",
      }),
      ctx.actor,
    );

    const bogus = unsafeVendorShortcode("VEN-9999");
    const { data } = await expenseList(
      ctx.db,
      { vendorId: bogus, vendorPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toEqual(["widening guard no-vendor row"]);
  });
});

describe("expense repository — productPresenceFilter", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it('"has" returns only expenses with a linked product', async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "presence linked drill" }),
      ctx.actor,
    );
    const { output: linked } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "linked expense",
        productId: product.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "unlinked expense",
      }),
      ctx.actor,
    );

    const { data } = await expenseList(
      ctx.db,
      { productPresenceFilter: "has" },
      [],
      pagination,
    );
    expect(data.map((p) => p.id)).toContain(linked.id);
    expect(data.map((p) => p.name)).not.toContain("unlinked expense");
  });

  it('"none" returns only expenses with no linked product', async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "presence linked sander" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "linked sander expense",
        productId: product.id,
      }),
      ctx.actor,
    );
    const { output: unlinked } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "unlinked sander expense",
      }),
      ctx.actor,
    );

    const { data } = await expenseList(
      ctx.db,
      { productPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(data.map((p) => p.id)).toContain(unlinked.id);
    expect(data.map((p) => p.name)).not.toContain("linked sander expense");
  });

  it('"has" still counts an expense whose linked product was later soft-deleted', async () => {
    // This is the documented semantic decision (buildExpenseWhereClause,
    // repo/expense/lookup.ts): "linked" means productId IS NOT NULL, which
    // deliberately includes rows whose product was soft-deleted afterward.
    // The public relation degrades to null because a dead target has no live
    // shortcode to expose, while the private FK still drives the filter.
    //
    // The state is written directly (mirrors location.integration.test.ts's
    // "a shelf holding only a soft-deleted product counts as empty") because
    // `deleteProducts` now refuses a product with a live expense
    // (PRODUCT_HAS_EXPENSES), so the single-delete path can't produce this
    // dangling link anymore. It's still a real state worth covering — a
    // sync/import path or a future admin tool could soft-delete a product out
    // from under its expenses — so the read-side degradation stays pinned.
    const doomedRouter = await createProduct(
      ctx.db,
      makeProductInput({ name: "presence doomed router" }),
      ctx.actor,
    );
    const { output: expense } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "doomed router expense",
        productId: doomedRouter.id,
      }),
      ctx.actor,
    );

    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(
        eq(
          product.id,
          unsafeProductId(
            (await resolveLiveShortcode(ctx.db, doomedRouter.id, "product"))!,
          ),
        ),
      );

    const hasFiltered = await expenseList(
      ctx.db,
      { productPresenceFilter: "has" },
      [],
      pagination,
    );
    expect(hasFiltered.data.map((p) => p.id)).toContain(expense.id);
    const stillLinked = hasFiltered.data.find((p) => p.id === expense.id);
    expect(stillLinked?.productId).toBeNull();
    expect(stillLinked?.productName).toBeNull();

    const noneFiltered = await expenseList(
      ctx.db,
      { productPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(noneFiltered.data.map((p) => p.id)).not.toContain(expense.id);
  });
});

describe("expense repository — charge grouping", () => {
  const ctx = withTestDb();

  const chargeLine = (
    name: string,
    vendor: string | null,
    orderId: string | null = null,
  ) =>
    expenseCreateInput.parse({
      date: "2024-01-15",
      trade: "other",
      costType: "materials",
      name,
      cost: 10,
      vendor,
      orderId,
    });

  it("files two lines of one order onto ONE charge, where they see each other", async () => {
    const orderId = "111-charge-0000001";
    const { output: first } = await createExpense(
      ctx.db,
      chargeLine("order line one", "Amazon", orderId),
      ctx.actor,
    );
    const { output: second } = await createExpense(
      ctx.db,
      chargeLine("order line two", "Amazon", orderId),
      ctx.actor,
    );
    // Same order id under a DIFFERENT vendor is a different charge — an order id
    // is only unique within a vendor, which is exactly what the partial-unique
    // `(vendorId, orderId)` index encodes.
    const { output: collision } = await createExpense(
      ctx.db,
      chargeLine("same id, other retailer", "Home Depot", orderId),
      ctx.actor,
    );
    const { output: otherOrder } = await createExpense(
      ctx.db,
      chargeLine("different order", "Amazon", "111-charge-0000002"),
      ctx.actor,
    );

    expect(purchaseIdOf(first)).toBe(purchaseIdOf(second));
    expect(purchaseIdOf(collision)).not.toBe(purchaseIdOf(first));
    expect(purchaseIdOf(otherOrder)).not.toBe(purchaseIdOf(first));

    const lines = await getPurchaseExpenses(
      ctx.db,
      await purchaseUuid(ctx.db, purchaseIdOf(first)),
    );
    expect(lines.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
    expect(lines.map((p) => p.id)).not.toContain(collision.id);
    expect(lines.map((p) => p.id)).not.toContain(otherOrder.id);
  });

  it("keeps two order-less buys from one vendor on SEPARATE charges", async () => {
    const { output: walkInA } = await createExpense(
      ctx.db,
      chargeLine("counter sale a", "Tool Nirvana"),
      ctx.actor,
    );
    const { output: walkInB } = await createExpense(
      ctx.db,
      chargeLine("counter sale b", "Tool Nirvana"),
      ctx.actor,
    );

    // Deliberate, not a miss: `(vendorId, null)` is not unique, and grouping by
    // `(vendor, date)` instead would falsely merge real rows (71 of them, across
    // 31 groups, on the live ledger). Two walk-in buys from one store are two
    // transactions; merging near-duplicates is `mergePurchases`, a user action.
    expect(purchaseIdOf(walkInA)).not.toBe(purchaseIdOf(walkInB));
    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(walkInA)),
        )
      ).map((p) => p.id),
    ).toEqual([walkInA.id]);
    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(walkInB)),
        )
      ).map((p) => p.id),
    ).toEqual([walkInB.id]);
  });

  it("gives a line with no vendor no charge at all", async () => {
    // An order id alone can't name a transaction (they're only unique per
    // vendor), so a vendorless line gets no charge rather than an unidentifiable
    // one — and the detail page's charge section stays off for it.
    const { output: loose } = await createExpense(
      ctx.db,
      chargeLine("cash, no receipt", null, "WN-no-vendor"),
      ctx.actor,
    );
    expect(loose.purchaseId).toBeNull();
    expect(loose.vendorId).toBeNull();
    expect(loose.orderId).toBeNull();
  });

  it("excludes a soft-deleted line of the charge", async () => {
    const orderId = "111-charge-deleted";
    const { output: keep } = await createExpense(
      ctx.db,
      chargeLine("surviving line", "Amazon", orderId),
      ctx.actor,
    );
    const { output: doomed } = await createExpense(
      ctx.db,
      chargeLine("deleted line", "Amazon", orderId),
      ctx.actor,
    );

    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(keep)),
        )
      ).map((p) => p.id),
    ).toContain(doomed.id);

    await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(keep)),
        )
      ).map((p) => p.id),
    ).toEqual([keep.id]);
  });
});

describe("expense repository — charge resolution on update", () => {
  const ctx = withTestDb();
  const page = { pageIndex: 0, pageSize: 100 };

  const line = (
    name: string,
    vendor: string | null,
    orderId: string | null = null,
  ) => makeExpenseInput({ name, cost: 10, vendor, orderId });

  const chargeCount = async (id: VendorShortcode) =>
    (await purchaseList(ctx.db, { vendorId: id }, [], page)).count;

  it("re-writing the SAME vendor onto an order-less row mints no second charge", async () => {
    // THE regression gate. `(vendorId, null)` is not unique, so
    // `findOrCreatePurchase` cannot dedupe an order-less charge — it always
    // inserts. Without `resolveCharge`'s `current` short-circuit, every save of
    // an unchanged vendor (an inline edit that re-submits the same value, a
    // re-import of the same row) created a fresh charge, re-pointed the expense
    // at it, and orphaned the previous one — `statedTotal` and attached
    // documents included.
    const { output: counterSale } = await createExpense(
      ctx.db,
      line("counter sale", "Tool Nirvana"),
      ctx.actor,
    );
    const vendorId = vendorIdOf(counterSale);
    const chargeBefore = purchaseIdOf(counterSale);
    expect(await chargeCount(vendorId)).toBe(1);

    const { output: rewritten } = await updateExpense(
      ctx.db,
      counterSale.id,
      { vendor: "Tool Nirvana" },
      ctx.actor,
    );

    expect(rewritten.purchaseId).toBe(chargeBefore);
    expect(await chargeCount(vendorId)).toBe(1);

    const { output: withOrder } = await createExpense(
      ctx.db,
      line("online order", "Tool Nirvana", "#11325"),
      ctx.actor,
    );
    const { output: restated } = await updateExpense(
      ctx.db,
      withOrder.id,
      { vendor: "Tool Nirvana", orderId: "#11325" },
      ctx.actor,
    );
    expect(restated.purchaseId).toBe(purchaseIdOf(withOrder));
    expect(await chargeCount(vendorId)).toBe(2); // the walk-in + this order
  });

  it("vendor: null detaches the line but leaves the charge and its other lines intact", async () => {
    const orderId = "111-detach-0000001";
    const { output: keep } = await createExpense(
      ctx.db,
      line("stays on the order", "Amazon", orderId),
      ctx.actor,
    );
    const { output: leaving } = await createExpense(
      ctx.db,
      line("mis-filed line", "Amazon", orderId),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(keep);
    expect(purchaseIdOf(leaving)).toBe(chargeId);

    const { output: detached } = await updateExpense(
      ctx.db,
      leaving.id,
      { vendor: null },
      ctx.actor,
    );
    expect(detached.purchaseId).toBeNull();
    expect(detached.vendorId).toBeNull();
    expect(detached.vendor).toBeNull();
    expect(detached.orderId).toBeNull();

    // Detaching one line is never a reason to delete the charge: the charge is
    // where `statedTotal` and the invoice PDF live, and its OTHER lines are real
    // spend. `null` means "this row isn't part of that transaction", not
    // "that transaction didn't happen".
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);
    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    expect(charge.orderId).toBe(orderId);
    expect(
      (await getPurchaseExpenses(ctx.db, chargeUuid)).map((p) => p.id),
    ).toEqual([keep.id]);
  });

  it("changing the vendor moves the line to the other vendor's charge, carrying its order id", async () => {
    const orderId = "WN-moved-0001";
    const { output: misattributed } = await createExpense(
      ctx.db,
      line("bought at the wrong store", "Lowe's", orderId),
      ctx.actor,
    );
    const wrongCharge = purchaseIdOf(misattributed);

    const { output: corrected } = await updateExpense(
      ctx.db,
      misattributed.id,
      { vendor: "Home Depot" },
      ctx.actor,
    );

    expect(corrected.purchaseId).not.toBe(wrongCharge);
    expect(corrected.vendor).toBe("Home Depot");
    expect(corrected.orderId).toBe(orderId);

    expect(
      await getPurchaseExpenses(
        ctx.db,
        await purchaseUuid(ctx.db, wrongCharge),
      ),
    ).toEqual([]);
  });

  it("adding an order id moves an order-less line onto the (vendor, orderId) charge, joining a sibling already there", async () => {
    const orderId = "111-adopt-0000001";
    const { output: alreadyFiled } = await createExpense(
      ctx.db,
      line("first line of the order", "Amazon", orderId),
      ctx.actor,
    );
    const { output: loose } = await createExpense(
      ctx.db,
      line("second line, order id not known yet", "Amazon"),
      ctx.actor,
    );
    expect(purchaseIdOf(loose)).not.toBe(purchaseIdOf(alreadyFiled));

    const { output: adopted } = await updateExpense(
      ctx.db,
      loose.id,
      { vendor: "Amazon", orderId },
      ctx.actor,
    );

    // Reconciling an order id is what MERGES the two lines: `(vendorId, orderId)`
    // is partial-unique, so the resolve finds the existing charge rather than
    // creating a second one for the same order.
    expect(adopted.purchaseId).toBe(purchaseIdOf(alreadyFiled));
    expect(adopted.orderId).toBe(orderId);
    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(alreadyFiled)),
        )
      )
        .map((p) => p.id)
        .sort(),
    ).toEqual([alreadyFiled.id, loose.id].sort());
  });

  // REGRESSION GUARD. This was a live bug: `resolveCharge` read only
  // `data.vendor` and returned "no change" whenever it was omitted, ignoring
  // `current.vendorName` sitting in the same argument — so an `{ orderId }`-only
  // update was silently dropped.
  //
  // It is not a hypothetical input shape, it is the ONLY shape the UI sends: both
  // Order # inline editors save `data: { orderId }` and nothing else
  // (app/expenses/expenselist.tsx and app/projects/shared.tsx), so typing an
  // order number into the ledger's Order # cell did nothing on every
  // vendor-bearing row — breaking the central purchase-import workflow.
  //
  // The test below this one pins the constraint the fix must not break: a
  // genuinely vendorless row still drops the order id.
  it("adopts an order id written on its own, using the vendor the row already has", async () => {
    const orderId = "111-alone-0000001";
    const { output: alreadyFiled } = await createExpense(
      ctx.db,
      line("first line of the order", "Amazon", orderId),
      ctx.actor,
    );
    const { output: loose } = await createExpense(
      ctx.db,
      line("order id typed in later", "Amazon"),
      ctx.actor,
    );

    const { output: adopted } = await updateExpense(
      ctx.db,
      loose.id,
      { orderId },
      ctx.actor,
    );

    expect(adopted.orderId).toBe(orderId);
    expect(adopted.purchaseId).toBe(purchaseIdOf(alreadyFiled));
  });

  it("an explicit purchaseId short-circuits name resolution and wins over a conflicting vendor", async () => {
    // `expenseCreateInput.purchaseId`'s doc: an id is never a guess, so there is
    // nothing to resolve. This is the purchase detail page's "add a line to this
    // charge" path — it must not be second-guessed by a stale vendor value the
    // form happened to carry along.
    const { output: anchor } = await createExpense(
      ctx.db,
      line("known charge anchor", "eBay", "eb-shortcircuit-1"),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(anchor);
    const { output: stray } = await createExpense(
      ctx.db,
      line("stray line", null),
      ctx.actor,
    );

    const { output: attached } = await updateExpense(
      ctx.db,
      stray.id,
      { purchaseId: chargeId, vendor: "Conflicting Vendor" },
      ctx.actor,
    );

    expect(attached.purchaseId).toBe(chargeId);
    expect(attached.vendor).toBe("eBay");
    expect(attached.orderId).toBe("eb-shortcircuit-1");
    // The short-circuit is before `findOrCreateVendor`, so the conflicting name
    // never reaches the roster — a resolve-anyway implementation would leave a
    // junk vendor row behind even though the id won.
    expect((await vendorOptions(ctx.db)).map((v) => v.name)).not.toContain(
      "Conflicting Vendor",
    );
  });

  it("drops an order id written with no vendor rather than half-recording it", async () => {
    // An order id alone can't name a transaction — they're only unique per
    // vendor — so there is no charge it could safely create. Dropped, not
    // stored on an unidentifiable charge.
    const { output: cash } = await createExpense(
      ctx.db,
      line("cash, no receipt", null),
      ctx.actor,
    );
    expect(cash.purchaseId).toBeNull();
    const chargesBefore = (await purchaseList(ctx.db, {}, [], page)).count;

    const { output: updated } = await updateExpense(
      ctx.db,
      cash.id,
      { orderId: "WN-no-vendor" },
      ctx.actor,
    );

    expect(updated.purchaseId).toBeNull();
    expect(updated.orderId).toBeNull();
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(
      chargesBefore,
    );
  });

  it("corrects a typo'd order id IN PLACE on a single-line charge, keeping its statedTotal", async () => {
    const { output: typo } = await createExpense(
      ctx.db,
      line("receipt with a typo", "Home Depot", "WN6344646"),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(typo);
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);
    const vendorId = vendorIdOf(typo);
    await updatePurchase(
      ctx.db,
      chargeId,
      { statedTotal: 10, notes: "invoice on file" },
      ctx.actor,
    );

    const { output: fixed } = await updateExpense(
      ctx.db,
      typo.id,
      { orderId: "WN63446464" },
      ctx.actor,
    );

    expect(fixed.purchaseId).toBe(chargeId);
    expect(fixed.orderId).toBe("WN63446464");
    expect(await chargeCount(vendorId)).toBe(1);
    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    expect(charge.statedTotal).toBe(10);
    expect(charge.notes).toBe("invoice on file");

    // Audited on the CHARGE: the rename returns `undefined` to `resolveCharge`,
    // so `expenseCrud.update` sees no column change and emits nothing — without
    // `renameChargeOrderId`'s own entry the edit would leave no trace anywhere.
    // `getAuditLog`'s `entityId` matches the internal uuid (what `logAuditEntry`
    // writes), not the shortcode.
    const chargeAudit = await getAuditLog(ctx.db, {
      entityType: "purchase",
      entityId: chargeUuid,
      limit: 20,
    });
    expect(
      chargeAudit.entries.some(
        (e) =>
          e.action === "update" &&
          (e.changes as { orderId?: { from: unknown; to: unknown } } | null)
            ?.orderId?.to === "WN63446464",
      ),
    ).toBe(true);

    const { output: cleared } = await updateExpense(
      ctx.db,
      typo.id,
      { orderId: null },
      ctx.actor,
    );
    expect(cleared.purchaseId).toBe(chargeId);
    expect(cleared.orderId).toBeNull();
    expect(await chargeCount(vendorId)).toBe(1);
  });

  /**
   * ATOMICITY GATE — fails on the pre-`withTransactionOn` code.
   *
   * `resolveCharge` used to run in its OWN transaction and commit, and only then
   * did the factory's column write run in a second one. So when the write failed
   * — `updateLiveAndReturn` throws when there is no live row, which is exactly
   * what a concurrent soft-delete produces — the vendor and charge it had just
   * minted survived with nothing pointing at them, and nothing sweeps up empty
   * charges. Same invariant `createExpense` already documents ("a vendor or
   * charge created here must not outlive a failed expense write"), which the
   * update path silently didn't hold.
   *
   * The delete-then-update ordering here is the deterministic form of the race:
   * the window it models is "soft-deleted after `resolveCharge` read the row",
   * and the observable outcome is identical.
   */
  it("rolls back a resolved vendor AND charge when the row was concurrently soft-deleted", async () => {
    const { output: doomed, entityId: doomedId } = await createExpense(
      ctx.db,
      line("about to be deleted", null),
      ctx.actor,
    );
    const chargesBefore = (await purchaseList(ctx.db, {}, [], page)).count;
    const vendorsBefore = (await vendorOptions(ctx.db)).length;

    await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

    await expect(
      updateExpense(
        ctx.db,
        doomed.id,
        { vendor: "Ghost Supply Co", orderId: "GSC-rollback-1" },
        ctx.actor,
      ),
    ).rejects.toThrow();

    expect((await vendorOptions(ctx.db)).map((v) => v.name)).not.toContain(
      "Ghost Supply Co",
    );
    expect((await vendorOptions(ctx.db)).length).toBe(vendorsBefore);
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(
      chargesBefore,
    );

    // And no audit entry for a write that never landed. `getAuditLog`'s
    // `entityId` matches the internal uuid, not the shortcode.
    const audit = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: doomedId,
      limit: 20,
    });
    expect(audit.entries.filter((e) => e.action === "update")).toEqual([]);
  });

  it("refuses an explicit purchaseId that points at a soft-deleted charge", async () => {
    // An FK proves the charge row exists, not that it isn't tombstoned, and an
    // explicit `purchaseId` skips `resolveCharge` entirely — so
    // `assertPurchaseLive` is the only thing between a direct API call and spend
    // filed against a dead charge.
    const { output: anchor } = await createExpense(
      ctx.db,
      line("line on a doomed charge", "eBay", "eb-tombstone-1"),
      ctx.actor,
    );
    const deadChargeId = purchaseIdOf(anchor);
    await deletePurchases(ctx.db, [deadChargeId], ctx.actor);

    await expect(
      createExpense(
        ctx.db,
        makeExpenseInput({
          name: "aimed at a dead charge",
          cost: 5,
          purchaseId: deadChargeId,
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });

    const { output: stray } = await createExpense(
      ctx.db,
      line("stray", null),
      ctx.actor,
    );
    await expect(
      updateExpense(ctx.db, stray.id, { purchaseId: deadChargeId }, ctx.actor),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });
    expect(
      (await getExpenseByShortcode(ctx.db, stray.id))?.purchaseId,
    ).toBeNull();

    await expect(
      updateExpense(
        ctx.db,
        stray.id,
        {
          purchaseId: unsafePurchaseShortcode("PUR-ZZZZ"),
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });
  });
});

describe("expense repository — orderIdPresenceFilter", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  const seed = async () => {
    const { output: hasOrderId } = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "amazon order line",
        vendor: "Amazon",
        orderId: "111-presence-0000001",
      }),
      ctx.actor,
    );
    const { output: chargeWithoutOrderId } = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "progress payment", vendor: "Flow Form" }),
      ctx.actor,
    );
    const { output: noCharge } = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "cash at the yard" }),
      ctx.actor,
    );

    expect(hasOrderId.orderId).toBe("111-presence-0000001");
    expect(purchaseIdOf(chargeWithoutOrderId)).toBeTruthy();
    expect(chargeWithoutOrderId.orderId).toBeNull();
    expect(noCharge.purchaseId).toBeNull();

    return { hasOrderId, chargeWithoutOrderId, noCharge };
  };

  it("'none' spans BOTH a charge-less row and a charge with a null order id", async () => {
    // The load-bearing case. `NOT IN (…)` evaluates to NULL — and so fails to
    // match — when the left side is NULL, so `notInArray(purchaseId, …)` ALONE
    // would silently drop every charge-less row from this bucket: 193 rows on the
    // real ledger, i.e. most of the unreconciled worklist. The `isNull` arm is
    // what puts them back, and both states must come back together because "no
    // order id" has always meant exactly that.
    const { hasOrderId, chargeWithoutOrderId, noCharge } = await seed();

    const { data } = await expenseList(
      ctx.db,
      { orderIdPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(data.map((p) => p.id).sort()).toEqual(
      [chargeWithoutOrderId.id, noCharge.id].sort(),
    );
    expect(data.map((p) => p.id)).not.toContain(hasOrderId.id);
  });

  it("'has' matches only rows whose charge carries an order id", async () => {
    const { hasOrderId } = await seed();

    const { data } = await expenseList(
      ctx.db,
      { orderIdPresenceFilter: "has" },
      [],
      pagination,
    );
    expect(data.map((p) => p.id)).toEqual([hasOrderId.id]);
  });

  it("contributes no constraint when unset", async () => {
    const { hasOrderId, chargeWithoutOrderId, noCharge } = await seed();

    const { data } = await expenseList(ctx.db, {}, [], pagination);
    expect(data.map((p) => p.id).sort()).toEqual(
      [hasOrderId.id, chargeWithoutOrderId.id, noCharge.id].sort(),
    );
  });
});

describe("expense repository — matchExpenses", () => {
  const ctx = withTestDb();

  const run = (
    rows: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ) => matchExpenses(ctx.db, expenseMatchInput.parse({ rows, ...overrides }));

  const line = (
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<ExpenseOut> =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "tools",
          name,
          ...extra,
        }),
        ctx.actor,
      ),
    );

  it("matches on amount+date with ZERO token overlap — the trap the matcher exists for", async () => {
    // The real case: a Festool vacuum was booked as `dust extractor`, so every
    // keyword search missed it and a duplicate row was added. Amount+date finds
    // it; the name is only used to grade afterwards.
    const extractor = await line("dust extractor", {
      cost: 599,
      date: "2024-06-10",
    });

    const result = await run([
      {
        key: "export-1",
        date: "2024-06-10",
        amount: 599,
        label: "Festool Vacuum CT 36 AC",
      },
    ]);

    const candidates = result.matches[0]?.candidates ?? [];
    expect(candidates.map((c) => c.expenseId)).toContain(extractor.id);

    const hit = candidates.find((c) => c.expenseId === extractor.id);
    expect(hit).toMatchObject({
      matchedOn: "amount_date",
      dayDelta: 0,
      amountDelta: 0,
      ratioLabel: "exact",
      // Zero shared tokens on a TRUE positive. This is exactly why overlap
      // grades and must never filter.
      tokenOverlap: 0,
    });
    expect(result.summary).toEqual({
      rowsIn: 1,
      rowsWithCandidates: 1,
      exactOrderIdHits: 0,
    });
  });

  it("classifies a nominal one-cent float delta as exact", async () => {
    const fourCentLine = await line("four-cent line", {
      cost: 0.04,
      date: "2026-04-03",
    });

    const result = await run([
      { key: "one-cent-gap", date: "2026-04-03", amount: 0.03 },
    ]);
    const hit = result.matches[0]?.candidates.find(
      (candidate) => candidate.expenseId === fourCentLine.id,
    );

    // `0.04 - 0.03` is 0.010000000000000002 as a raw float. The documented
    // boundary is one cent, so classification must happen after cent rounding.
    expect(hit?.ratioLabel).toBe("exact");
  });

  it("computes the amount window on the SIGNED amount, so credits match credits", async () => {
    const refund = await line("festool accessory refund", {
      cost: -96.67,
      date: "2025-12-01",
    });
    const purchaseOfSameSize = await line("something bought for 96.67", {
      cost: 96.67,
      date: "2025-12-01",
    });

    const result = await run([
      { key: "credit", date: "2025-12-01", amount: -96.67 },
    ]);
    const ids = (result.matches[0]?.candidates ?? []).map((c) => c.expenseId);

    expect(ids).toContain(refund.id);
    // The window is roughly [-111, -87] — a POSITIVE row of the same magnitude
    // is nowhere near it. Getting the sign wrong here would silently break
    // every disposal reconciliation.
    expect(ids).not.toContain(purchaseOfSameSize.id);
  });

  it("excludes null-cost rows from the amount arm", async () => {
    const noCost = await line("no cost recorded", { date: "2026-03-01" });
    const real = await line("real row", { cost: 250, date: "2026-03-01" });
    expect(noCost.cost).toBeNull();

    const result = await run([{ key: "r", date: "2026-03-01", amount: 250 }]);
    const ids = (result.matches[0]?.candidates ?? []).map((c) => c.expenseId);

    expect(ids).toEqual([real.id]);
    expect(ids).not.toContain(noCost.id);
  });

  it("ranks an order-id hit above a closer amount match, and ignores the day window for it", async () => {
    // The order-id row is deliberately WORSE on both amount and date: far
    // outside the day window, and nowhere near the export amount. It must still
    // rank first, because an order id is an identifier and amount+date is a
    // guess.
    const byOrderId = await line("b&h order line", {
      cost: 203.36,
      date: "2025-01-05",
      vendor: "Matcher B&H",
      orderId: "1121197219",
    });
    const closerOnAmount = await line("coincidence", {
      cost: 306.27,
      date: "2025-06-01",
    });

    const result = await run([
      {
        key: "bh",
        date: "2025-06-01",
        amount: 306.27,
        orderId: "1121197219",
      },
    ]);

    const candidates = result.matches[0]?.candidates ?? [];
    expect(candidates[0]).toMatchObject({
      expenseId: byOrderId.id,
      matchedOn: "order_id",
      orderId: "1121197219",
      vendorName: "Matcher B&H",
      purchase: {
        orderId: "1121197219",
        vendorName: "Matcher B&H",
        expenseCount: 1,
        expenseTotal: 203.36,
        financialReconciliation: {
          status: "unknown",
          transactionCount: 0,
          postedTransactionCount: 0,
          outstandingTransactionCount: 0,
          postedTotal: 0,
          projectedTotal: 0,
          postedRefundTotal: 0,
          delta: null,
        },
      },
    });
    expect(candidates[0]?.dayDelta).toBe(-147);
    expect(candidates.map((c) => c.expenseId)).toContain(closerOnAmount.id);
    expect(result.summary.exactOrderIdHits).toBe(1);
  });

  it("suppresses amount/date-only coincidences after a confirmed same-vendor order hit, while keeping all order siblings", async () => {
    const orderId = "MATCHER-CONFIRMED-SIBLINGS";
    const component = await line("order component", {
      cost: 60,
      date: "2025-01-05",
      vendor: "Matcher Confirmed Vendor",
      orderId,
    });
    const aggregate = await line("order aggregate", {
      cost: 100,
      date: "2025-01-05",
      vendor: "Matcher Confirmed Vendor",
      orderId,
    });
    const coincidence = await line("unrelated amount coincidence", {
      cost: 100,
      date: "2026-06-01",
    });

    const result = await run([
      {
        key: "confirmed",
        date: "2026-06-01",
        amount: 100,
        orderId,
        vendor: "Matcher Confirmed Vendor",
      },
    ]);
    const candidates = result.matches[0]?.candidates ?? [];
    const ids = candidates.map((candidate) => candidate.expenseId);

    expect(ids).toEqual(expect.arrayContaining([component.id, aggregate.id]));
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expenseId: component.id,
          matchedOn: "order_id",
          vendorMatch: true,
        }),
        expect.objectContaining({
          expenseId: aggregate.id,
          matchedOn: "order_id",
          vendorMatch: true,
        }),
      ]),
    );
    expect(ids).not.toContain(coincidence.id);
  });

  it("keeps amount/date candidates when an exact order hit conflicts with the input vendor", async () => {
    const orderId = "MATCHER-VENDOR-CONFLICT";
    const conflict = await line("other retailer's same order id", {
      cost: 500,
      date: "2024-01-01",
      vendor: "Matcher Other Retailer",
      orderId,
    });
    const amountCandidate = await line("plausible amount candidate", {
      cost: 75,
      date: "2026-06-01",
    });

    const result = await run([
      {
        key: "conflict",
        date: "2026-06-01",
        amount: 75,
        orderId,
        vendor: "Matcher Expected Retailer",
      },
    ]);
    const candidates = result.matches[0]?.candidates ?? [];

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expenseId: conflict.id,
          matchedOn: "order_id",
          vendorMatch: false,
        }),
        expect.objectContaining({
          expenseId: amountCandidate.id,
          matchedOn: "amount_date",
        }),
      ]),
    );
  });

  it("keeps amount/date candidates when vendor identity is unknown", async () => {
    const orderId = "MATCHER-VENDOR-UNKNOWN";
    const exact = await line("order with no input vendor", {
      cost: 500,
      date: "2024-01-01",
      vendor: "Matcher Known Vendor",
      orderId,
    });
    const amountCandidate = await line("plausible unknown-vendor candidate", {
      cost: 75,
      date: "2026-06-01",
    });

    const result = await run([
      { key: "unknown", date: "2026-06-01", amount: 75, orderId },
    ]);
    const candidates = result.matches[0]?.candidates ?? [];

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expenseId: exact.id,
          matchedOn: "order_id",
          vendorMatch: null,
        }),
        expect.objectContaining({
          expenseId: amountCandidate.id,
          matchedOn: "amount_date",
        }),
      ]),
    );
  });

  it("matches order ids exactly without stripping leading zeroes", async () => {
    const leadingZero = await line("leading-zero order", {
      cost: 50,
      date: "2024-01-01",
      vendor: "Matcher Zero Vendor",
      orderId: "000123",
    });
    const noLeadingZero = await line("different order without zeroes", {
      cost: 500,
      date: "2020-01-01",
      vendor: "Matcher Zero Vendor",
      orderId: "123",
    });

    const result = await run([
      {
        key: "zeroes",
        date: "2026-06-01",
        amount: 50,
        orderId: "000123",
        vendor: "Matcher Zero Vendor",
      },
    ]);
    const ids = (result.matches[0]?.candidates ?? []).map(
      (candidate) => candidate.expenseId,
    );

    expect(ids).toContain(leadingZero.id);
    expect(ids).not.toContain(noLeadingZero.id);
  });

  it("demotes a cross-vendor orderId collision below every amount+date hit", async () => {
    // An order id is unique only WITHIN a vendor — `Purchase_vendorId_orderId_key`
    // is UNIQUE(vendorId, orderId), and short ids genuinely collide across
    // retailers. Without vendor scoping the collision would take the top slot,
    // since the order-id arm ignores the day window and normally ranks first.
    const collidingId = "#11325";
    const wrongVendor = await line("metal supermarkets bar stock", {
      cost: 8000,
      date: "2020-01-01",
      vendor: "Matcher Metal Supermarkets",
      orderId: collidingId,
    });
    const rightVendor = await line("tool nirvana order line", {
      cost: 60,
      date: "2026-06-02",
      vendor: "Matcher Tool Nirvana",
      orderId: collidingId,
    });

    const result = await run([
      {
        key: "tn",
        date: "2026-06-01",
        amount: 60,
        orderId: collidingId,
        vendor: "Matcher Tool Nirvana",
      },
    ]);
    const candidates = result.matches[0]?.candidates ?? [];
    const rank = (id: string) =>
      candidates.findIndex((c) => c.expenseId === id);

    expect(candidates[0]).toMatchObject({
      expenseId: rightVendor.id,
      matchedOn: "order_id",
      vendorMatch: true,
    });

    const collision = candidates.find((c) => c.expenseId === wrongVendor.id);
    expect(collision).toMatchObject({
      matchedOn: "order_id",
      vendorMatch: false,
    });
    expect(rank(wrongVendor.id)).toBeGreaterThan(rank(rightVendor.id));
  });

  it("treats a case/whitespace vendor difference as agreement, not a conflict", async () => {
    // Roster names are matched EXACTLY elsewhere, so an export spelled
    // "AMAZON " must not read as a different counterparty here — that would
    // demote a true order-id hit.
    const row = await line("amazon order line", {
      cost: 42,
      date: "2026-06-10",
      vendor: "Matcher Amazon",
      orderId: "111-CASE-TEST",
    });
    const coincidence = await line("unrelated matching amount", {
      cost: 42,
      date: "2026-06-10",
    });

    const result = await run([
      {
        key: "amz",
        date: "2026-06-10",
        amount: 42,
        orderId: "111-CASE-TEST",
        vendor: "  matcher AMAZON  ",
      },
    ]);

    const candidates = result.matches[0]?.candidates ?? [];
    expect(candidates[0]).toMatchObject({
      expenseId: row.id,
      matchedOn: "order_id",
      vendorMatch: true,
    });
    expect(candidates.map((candidate) => candidate.expenseId)).not.toContain(
      coincidence.id,
    );
  });

  it("reports vendorMatch: null when there is nothing to compare", async () => {
    const row = await line("no vendor on the export line", {
      cost: 15,
      date: "2026-06-20",
      vendor: "Matcher Somewhere",
      orderId: "NV-1",
    });

    const result = await run([
      { key: "nv", date: "2026-06-20", amount: 15, orderId: "NV-1" },
    ]);

    expect(result.matches[0]?.candidates[0]).toMatchObject({
      expenseId: row.id,
      matchedOn: "order_id",
      vendorMatch: null,
    });
  });

  it("explains each hit instead of enumerating tax hypotheses", async () => {
    const exact = await line("exact", { cost: 100, date: "2026-05-01" });
    const plusTax = await line("plus tax", {
      cost: 108.63,
      date: "2026-05-01",
    });
    const preTax = await line("pre tax", { cost: 92.06, date: "2026-05-01" });
    const shipping = await line("plus shipping", {
      cost: 109.99,
      date: "2026-05-01",
    });

    const result = await run([{ key: "r", date: "2026-05-01", amount: 100 }]);
    const byId = new Map(
      (result.matches[0]?.candidates ?? []).map((c) => [c.expenseId, c]),
    );

    expect(byId.get(exact.id)?.ratioLabel).toBe("exact");
    expect(byId.get(plusTax.id)?.ratioLabel).toBe("plus_tax");
    expect(byId.get(preTax.id)?.ratioLabel).toBe("pre_tax");

    // The whole point of the design: an ADDITIVE $9.99 fee is not a tax
    // hypothesis and is not supposed to be labelled as one. It comes back as
    // `other` with the residual sitting right there as a plain number a human
    // recognizes as shipping — where a discrete `cost x 1.08625` check would
    // have rejected it outright.
    const fee = byId.get(shipping.id);
    expect(fee?.ratioLabel).toBe("other");
    expect(fee?.amountDelta).toBeCloseTo(9.99, 2);
  });

  it("caps candidates per row and orders by closeness", async () => {
    for (let i = 0; i < 6; i += 1) {
      await line(`bulk ${i}`, { cost: 200 + i * 0.5, date: "2026-07-01" });
    }

    const result = await run([{ key: "r", date: "2026-07-01", amount: 200 }], {
      maxCandidatesPerRow: 3,
    });
    const candidates = result.matches[0]?.candidates ?? [];

    expect(candidates).toHaveLength(3);
    const deltas = candidates.map((c) => Math.abs(c.amountDelta ?? 0));
    expect(deltas).toEqual([...deltas].sort((a, b) => a - b));
  });

  it("excludes soft-deleted expenses, and reports unmatched keys", async () => {
    const deleted = await line("deleted row", {
      cost: 777,
      date: "2026-08-01",
    });
    await deleteExpenses(ctx.db, [deleted.id], ctx.actor);

    const result = await run([
      { key: "gone", date: "2026-08-01", amount: 777 },
      { key: "never-existed", date: "2026-08-01", amount: 123456 },
    ]);

    expect(result.matches).toEqual([]);
    expect(result.unmatched.sort()).toEqual(["gone", "never-existed"]);
    expect(result.summary).toEqual({
      rowsIn: 2,
      rowsWithCandidates: 0,
      exactOrderIdHits: 0,
    });
  });

  /**
   * The sub-$20 hazard, pinned as behavior rather than wished away.
   *
   * A $0.93 order once false-matched a $1.00 `5 yd nursery mix` row and had to
   * be reverted. It is INSIDE any sane relative band (the two are 7.5% apart,
   * against a 10%/15% default), and the absolute floor widens the band further
   * so small amounts get a usable one at all. So the matcher returns it — that
   * is correct for a tool that ranks rather than decides.
   *
   * What protects against it is the grading signal plus the tool description's
   * instruction to read the line descriptions under ~$20, NOT a filter.
   */
  it("still surfaces the small-amount false positive, with zero overlap to grade it down", async () => {
    const nurseryMix = await line("5 yd nursery mix", {
      cost: 1.0,
      date: "2024-04-01",
    });

    const result = await run([
      {
        key: "screws",
        date: "2024-04-01",
        amount: 0.93,
        label: "wood screws",
      },
    ]);
    const hit = (result.matches[0]?.candidates ?? []).find(
      (c) => c.expenseId === nurseryMix.id,
    );

    expect(hit).toBeDefined();
    expect(hit?.tokenOverlap).toBe(0);
    expect(hit?.ratioLabel).toBe("other");
    expect(hit?.amountDelta).toBeCloseTo(0.07, 2);
  });

  it("scores token overlap when the names DO agree", async () => {
    const milwaukee = await line("milwaukee packout rolling toolbox", {
      cost: 149,
      date: "2026-09-01",
    });

    const result = await run([
      {
        key: "r",
        date: "2026-09-01",
        amount: 149,
        label: "Milwaukee PACKOUT Rolling Tool Box",
      },
    ]);
    const hit = (result.matches[0]?.candidates ?? []).find(
      (c) => c.expenseId === milwaukee.id,
    );

    expect(hit?.tokenOverlap).toBe(3);
  });
});

describe("expense repository — food-line default project", () => {
  const ctx = withTestDb();

  const seedHousehold = async () => {
    const { entityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Household" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(project)
      .set({ shortcode: HOUSEHOLD_PROJECT_SHORTCODE })
      .where(eq(project.id, entityId));
  };

  const foodProduct = () =>
    createProduct(
      ctx.db,
      makeProductInput({ name: "default-project food", category: "food" }),
      ctx.actor,
    );

  const toolsProduct = () =>
    createProduct(
      ctx.db,
      makeProductInput({ name: "default-project tool", category: "tools" }),
      ctx.actor,
    );

  it("defaults a food product with no explicit project to Household", async () => {
    await seedHousehold();
    const prod = await foodProduct();

    const created = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ productId: prod.id, projectId: null }),
        ),
        ctx.actor,
      ),
    );

    expect(created.projectId).toBe(HOUSEHOLD_PROJECT_SHORTCODE);
  });

  it("leaves a non-food (tools) product's null project untouched — pins the rule's scope", async () => {
    await seedHousehold();
    const prod = await toolsProduct();

    const created = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ productId: prod.id, projectId: null }),
        ),
        ctx.actor,
      ),
    );

    expect(created.projectId).toBeNull();
  });

  it("never overrides an explicitly chosen project", async () => {
    await seedHousehold();
    const prod = await foodProduct();
    const { output: explicitProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "explicit food project" }),
      ctx.actor,
    );

    const created = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            productId: prod.id,
            projectId: explicitProject.id,
          }),
        ),
        ctx.actor,
      ),
    );

    expect(created.projectId).toBe(explicitProject.id);
  });

  it("stays null when no Household project has been seeded", async () => {
    const prod = await foodProduct();

    const created = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ productId: prod.id, projectId: null }),
        ),
        ctx.actor,
      ),
    );

    expect(created.projectId).toBeNull();
  });

  it("updateExpense clearing the project on a Household food line stays cleared", async () => {
    await seedHousehold();
    const prod = await foodProduct();
    const created = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ productId: prod.id, projectId: null }),
        ),
        ctx.actor,
      ),
    );
    expect(created.projectId).toBe(HOUSEHOLD_PROJECT_SHORTCODE);

    const updated = await unwrap(
      updateExpense(ctx.db, created.id, { projectId: null }, ctx.actor),
    );

    expect(updated.projectId).toBeNull();
  });

  it("moveExpenses to the inbox is never re-triaged back to Household", async () => {
    await seedHousehold();
    const prod = await foodProduct();
    const created = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ productId: prod.id, projectId: null }),
        ),
        ctx.actor,
      ),
    );
    expect(created.projectId).toBe(HOUSEHOLD_PROJECT_SHORTCODE);

    const moved = await moveExpenses(
      ctx.db,
      { ids: [created.id], projectId: null },
      ctx.actor,
    );

    expect(moved.map((e) => e.projectId)).toEqual([null]);
  });
});

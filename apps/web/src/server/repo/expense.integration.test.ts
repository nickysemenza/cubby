import type {
  ExpenseId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import {
  unsafeExpenseId,
  unsafeProjectId,
  unsafePurchaseId,
} from "@cubby/schemas/identifiers";
import {
  type ExpenseCreateInput,
  type ExpenseOut,
  expenseCreateInput,
  projectCreateInput,
} from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { expenseRouter } from "~/server/api/routers/expense";
import { createTestCaller } from "~/server/api/trpc";
import { product } from "~/server/db/schema";
import { getAuditLog } from "~/server/repo/audit-log";
import { getDb } from "~/server/repo/database-helpers";
import { findOrphanedEntityEmbeddings } from "~/server/repo/entity-embedding";
import {
  createExpense,
  deleteExpenses,
  expenseAnalytics,
  expenseList,
  getExpenseByID,
  moveExpenses,
  setExpensesCostType,
  setExpensesTrade,
  updateExpense,
} from "~/server/repo/expense";
import { createProduct, deleteProducts } from "~/server/repo/product";
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
import { vendorOptions } from "~/server/repo/vendor";

/**
 * `vendor` on the create input still resolves into a real `Vendor` + `Purchase`
 * (see `resolveCharge`), so a row created by NAME comes back carrying the ids
 * every filter and grouping assertion below needs. Throwing rather than
 * asserting inline keeps the id non-nullable at the call site.
 */
const vendorIdOf = (expense: ExpenseOut): VendorId => {
  if (!expense.vendorId) {
    throw new Error(`expected a resolved vendor on "${expense.name}"`);
  }
  return expense.vendorId;
};

const purchaseIdOf = (expense: ExpenseOut): PurchaseId => {
  if (!expense.purchaseId) {
    throw new Error(`expected a resolved charge on "${expense.name}"`);
  }
  return expense.purchaseId;
};

// NB: project rollup contribution (spend/expenseCount/subtree) and
// project-delete-blocking-on-live-expenses are already covered in
// project.integration.test.ts ("rolls up spend..." and "blocks deletion
// while live tasks or expenses still reference the project") — not
// re-asserted here.

describe("expense repository — CRUD", () => {
  const ctx = withTestDb();

  it("creates, reads (with projectName join), updates (incl. clearing date/projectId), and deletes", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "expense crud project" }),
      ctx.actor,
    );

    const created = await createExpense(
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

    const read = await getExpenseByID(ctx.db, created.id);
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

    const updated = await updateExpense(
      ctx.db,
      created.id,
      { name: "updated faucet", cost: 55, date: null, projectId: null },
      ctx.actor,
    );
    expect(updated.name).toBe("updated faucet");
    expect(updated.cost).toBe(55);
    expect(updated.date).toBeNull();
    expect(updated.projectId).toBeNull();
    expect(updated.projectName).toBeNull();

    await deleteExpenses(ctx.db, [created.id], ctx.actor);

    await expect(getExpenseByID(ctx.db, created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "EXPENSE_NOT_FOUND" },
    });

    const { data } = await expenseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(data.map((p) => p.id)).not.toContain(created.id);
  });
});

describe("expense repository — expenseList filters", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("filters by search, costType, trade, future", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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

  it("filters by projectId, and projectId + includeSubProjects over a 3-level chain", async () => {
    const parent = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "filter parent" }),
      ctx.actor,
    );
    const child = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "filter child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );
    const grandchild = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "filter grandchild",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );
    const other = await createProject(
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

  it("filters by dateFrom/dateTo (inclusive boundary, outside window, null-date excluded)", async () => {
    const inWindow = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "in window",
        date: "2026-02-15",
      }),
      ctx.actor,
    );
    const lowerBoundary = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "on lower boundary",
        date: "2026-02-01",
      }),
      ctx.actor,
    );
    const upperBoundary = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "on upper boundary",
        date: "2026-02-28",
      }),
      ctx.actor,
    );
    const beforeWindow = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "before window",
        date: "2026-01-01",
      }),
      ctx.actor,
    );
    const afterWindow = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "after window",
        date: "2026-03-01",
      }),
      ctx.actor,
    );
    const nullDate = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "no date (future)",
        future: true,
      }),
      ctx.actor,
    );
    expect(nullDate.date).toBeNull();

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
    expect(windowed.data.map((p) => p.id)).not.toContain(nullDate.id);

    // dateFrom alone — open upper bound.
    const fromOnly = await expenseList(
      ctx.db,
      { dateFrom: "2026-02-28" },
      [],
      pagination,
    );
    expect(new Set(fromOnly.data.map((p) => p.id))).toEqual(
      new Set([upperBoundary.id, afterWindow.id]),
    );

    // dateTo alone — open lower bound.
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

  it("combines filters with AND semantics", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "combined filter project" }),
      ctx.actor,
    );
    const matches = await createExpense(
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
    // Right project, wrong trade.
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
    // Right everything, wrong date.
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

    // Default sort: date.
    const byDate = await expenseList(
      ctx.db,
      {},
      [{ orderBy: "date", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(byDate.data[0]?.date).toBe("2026-01-01");
    expect(byDate.data[2]?.date).toBe("2026-01-02");

    // Multi-sort: date asc, then cost desc as a tiebreak among the two
    // same-day rows.
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

    // Small page size — count still reflects the full unpaginated total.
    const { data: page, count } = await expenseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 2,
    });
    expect(page).toHaveLength(2);
    expect(count).toBe(3);
  });
});

describe("expense router", () => {
  const ctx = withTestDb();

  it("chartData returns the filtered set", async () => {
    const caller = createTestCaller(expenseRouter, ctx.db);
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "chart match",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
    /** One assigned expense, one unassigned, plus a decoy in another project. */
    const seedProjectMix = async () => {
      const [projA, projB] = await Promise.all([
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
      const caller = createTestCaller(expenseRouter, ctx.db);
      await seedProjectMix();

      const rows = await caller.chartData({ projectPresenceFilter: "none" });
      const names = rows.map((p) => p.name);
      expect(names).toContain("needs a project");
      expect(names).not.toContain("has a project");
      expect(names).not.toContain("other project");
    });

    it("'has' returns only assigned expenses", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      await seedProjectMix();

      const names = (
        await caller.chartData({ projectPresenceFilter: "has" })
      ).map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(["has a project", "other project"]),
      );
      expect(names).not.toContain("needs a project");
    });

    // The case the old `noProject` boolean could not express at all: it AND-ed
    // with projectId, so this pair matched nothing. Presence now ORs.
    it("combines with projectId as OR — that project plus the unassigned", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
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
      const caller = createTestCaller(expenseRouter, ctx.db);
      const { projA } = await seedProjectMix();
      const filters = {
        projectId: [projA.id],
        projectPresenceFilter: "none" as const,
      };

      const [listed, analytics] = await Promise.all([
        caller.list({ filters }),
        caller.analytics(filters),
      ]);

      expect(analytics.summary.count).toBe(listed.items.length);
      expect(analytics.summary.net).toBeCloseTo(
        listed.items.reduce((sum, p) => sum + (p.cost ?? 0), 0),
        2,
      );
    });
  });

  describe("chargeSiblings", () => {
    it("returns the charge's other lines, excluding the expense itself", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      const orderId = "111-siblings-0000001";
      const [self, sibling] = await Promise.all([
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
      // A line of a DIFFERENT charge, to prove the scope is the charge and not
      // the vendor.
      await createExpense(
        ctx.db,
        makeExpenseInput({ name: "unrelated amazon buy", vendor: "Amazon" }),
        ctx.actor,
      );

      const siblings = await caller.chargeSiblings(self.id);
      // `getPurchaseExpenses` includes the source row (the charge total needs
      // it); the detail section filters itself out here, so a single-line charge
      // renders nothing rather than a list of one.
      expect(siblings.map((p) => p.id)).toEqual([sibling.id]);
    });

    it("returns [] for an expense with no charge — without early-returning on a missing order id", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      const chargeless = await createExpense(
        ctx.db,
        makeExpenseInput({ name: "cash, no vendor" }),
        ctx.actor,
      );
      expect(chargeless.purchaseId).toBeNull();
      expect(await caller.chargeSiblings(chargeless.id)).toEqual([]);

      // The distinction the old `orderSiblings` got wrong: it bailed on a missing
      // ORDER ID, which would have hidden this section for the 33% of
      // vendor-bearing rows that have none — even though they sit on a real
      // charge with real siblings. Gating on `purchaseId` instead is what fixed
      // it.
      const orderless = await createExpense(
        ctx.db,
        makeExpenseInput({ name: "walk-in line a", vendor: "Tool Nirvana" }),
        ctx.actor,
      );
      const alsoOnThatCharge = await createExpense(
        ctx.db,
        makeExpenseInput({
          name: "walk-in line b",
          purchaseId: purchaseIdOf(orderless),
        }),
        ctx.actor,
      );
      expect(orderless.orderId).toBeNull();
      expect(
        (await caller.chargeSiblings(orderless.id)).map((p) => p.id),
      ).toEqual([alsoOnThatCharge.id]);
    });
  });

  it("tradeAffinity counts assigned expenses per project and trade", async () => {
    const caller = createTestCaller(expenseRouter, ctx.db);
    const proj = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "affinity project" }),
      ctx.actor,
    );
    for (const trade of ["drywall", "drywall", "electrical"] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          trade,
          costType: "materials",
          name: `affinity ${trade}`,
          projectId: proj.id,
        }),
        ctx.actor,
      );
    }
    // Unassigned rows have no project to weight, so they must not appear.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "drywall",
        costType: "materials",
        name: "affinity unassigned",
      }),
      ctx.actor,
    );

    const matrix = await caller.tradeAffinity();
    const forProject = matrix.filter((row) => row.projectId === proj.id);
    expect(forProject.find((row) => row.trade === "drywall")?.count).toBe(2);
    expect(forProject.find((row) => row.trade === "electrical")?.count).toBe(1);
  });

  it("bulkMove moves expenses to another project and to the inbox (null), returning items + sideEffects", async () => {
    const caller = createTestCaller(expenseRouter, ctx.db);
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "bulk move a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "bulk move b" }),
      ctx.actor,
    );
    const p1 = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "bulk move expense 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const p2 = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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

    // expenseBulkMoveInput allows a null projectId — moves to the inbox.
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
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses b" }),
      ctx.actor,
    );
    const p1 = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "move me 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const p2 = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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

    const auditP1 = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: p1.id,
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
  });

  it("leaves soft-deleted ids in the input untouched", async () => {
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses untouched a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses untouched b" }),
      ctx.actor,
    );
    const live = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "still live",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const deleted = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
    // Only the live row comes back — the soft-deleted id is silently excluded,
    // not moved.
    expect(moved.map((p) => p.id)).toEqual([live.id]);
  });

  it("rejects a nonexistent or soft-deleted target project with PROJECT_NOT_FOUND", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses reject source" }),
      ctx.actor,
    );
    const expenseRow = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "reject target",
        projectId: project.id,
      }),
      ctx.actor,
    );
    const bogusProjectId = unsafeProjectId(
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

    const deletedProject = await createProject(
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
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses noop project" }),
      ctx.actor,
    );
    const bogusId = unsafeExpenseId("00000000-0000-0000-0000-000000000000");

    const moved = await moveExpenses(
      ctx.db,
      { ids: [bogusId], projectId: project.id },
      ctx.actor,
    );
    expect(moved).toEqual([]);
  });
});

/**
 * The two bulk enum writers behind the ledger's selection toolbar
 * (`expense-bulk-actions.tsx` → `bulkSetTrade` / `bulkSetCostType`). Same shape
 * as `moveExpenses` minus the FK assert — a plain audited column write over
 * `ids` — so what's worth pinning is the part that isn't the column write: the
 * audit entry fires only for rows whose value actually CHANGED, and a
 * soft-deleted id is skipped rather than resurrected.
 */
describe("expense repository — bulk trade / cost-type writes", () => {
  const ctx = withTestDb();

  const line = (name: string, overrides: Partial<ExpenseCreateInput> = {}) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput({ name, ...overrides })),
      ctx.actor,
    );

  /** `update` audit entries for one expense. */
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
    const a = await line("bulk trade a", { trade: "other" });
    const b = await line("bulk trade b", { trade: "other" });
    // Already carries the target value: it must be written (harmlessly) but NOT
    // audited — `computeChanges` returns null, so the `if (changes)` arm skips it.
    const already = await line("bulk trade already electrical", {
      trade: "electrical",
    });
    const untouched = await line("bulk trade bystander", { trade: "plumbing" });

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
    // Not in `ids` — a bulk write must never widen past its selection.
    expect((await getExpenseByID(ctx.db, untouched.id)).trade).toBe("plumbing");

    expect(changeOf((await updateEntries(a.id))[0], "trade")).toEqual({
      from: "other",
      to: "electrical",
    });
    expect(await updateEntries(already.id)).toHaveLength(0);
  });

  it("setExpensesTrade skips soft-deleted ids and returns [] when nothing live matches", async () => {
    const live = await line("bulk trade live", { trade: "other" });
    const deleted = await line("bulk trade deleted", { trade: "other" });
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
    const a = await line("bulk costType a", { costType: "materials" });
    const already = await line("bulk costType already tools", {
      costType: "tools",
    });

    const updated = await setExpensesCostType(
      ctx.db,
      { ids: [a.id, already.id], costType: "tools" },
      ctx.actor,
    );
    expect(updated.map((row) => row.costType)).toEqual(["tools", "tools"]);

    expect(changeOf((await updateEntries(a.id))[0], "costType")).toEqual({
      from: "materials",
      to: "tools",
    });
    expect(await updateEntries(already.id)).toHaveLength(0);
  });
});

describe("expense repository — expenseAnalytics", () => {
  const ctx = withTestDb();

  it("aggregates match manual arithmetic, omits empty categories, and stays consistent with expenseList under the same filter", async () => {
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analytics project a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analytics project b" }),
      ctx.actor,
    );

    // p1: actual spend, plumbing/materials, projectA, dated Jan.
    const p1 = await createExpense(
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
    // p2: committed (future) spend, plumbing/materials, projectA, no date yet.
    const p2 = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "analytics p2 committed",
        projectId: projectA.id,
        cost: 50,
        future: true,
      }),
      ctx.actor,
    );
    // p3: a credit/refund (negative cost), electrical/materials, no project (inbox), dated Jan.
    const p3 = await createExpense(
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
    // p4: actual spend, electrical/services, projectB, dated Feb.
    const p4 = await createExpense(
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

    const filters = { search: "analytics p" };
    const result = await expenseAnalytics(ctx.db, filters);

    // --- summary: actual=100+30, committed=50, credits=20, net=160 ---
    expect(result.summary).toEqual({
      actual: 130,
      committed: 50,
      credits: 20,
      net: 160,
      count: 4,
      actualCount: 3, // p1, p3, p4 (future: false)
      plannedCount: 1, // p2
    });

    // --- byCostType: only materials/services appear (no other costType seeded) ---
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

    // --- byTrade: plumbing + electrical only ---
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

    // --- tradeCostMatrix: the 3 combos actually present, not the full cross product ---
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

    // --- monthly: p2 (no date) excluded; Jan (p1, p3) and Feb (p4) only ---
    expect(result.monthly).toEqual([
      {
        month: "2026-01",
        actual: 100,
        committed: 0,
        credits: 20,
        net: 80,
        count: 2,
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

    // --- cumulative: running sum of monthly.net, ascending ---
    expect(result.cumulative).toEqual([
      { month: "2026-01", cumulativeNet: 80 },
      { month: "2026-02", cumulativeNet: 110 },
    ]);

    // --- byProject: p3 (no project) excluded ---
    expect(result.byProject).toEqual(
      expect.arrayContaining([
        {
          projectId: projectA.id,
          projectName: projectA.name,
          actual: 100,
          committed: 50,
          credits: 0,
          net: 150,
          count: 2,
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

    // --- core invariant: analytics totals agree with expenseList's visible
    // rows under the SAME filter — sum expenseList's `cost` column and
    // compare against summary.net (both should equal 160). ---
    const { data: listedRows } = await expenseList(ctx.db, filters, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    expect(listedRows.map((p) => p.id).sort()).toEqual(
      [p1.id, p2.id, p3.id, p4.id].sort(),
    );
    const summedCost = listedRows.reduce((sum, p) => sum + (p.cost ?? 0), 0);
    expect(summedCost).toBe(result.summary.net);
  });

  it("applies the same filters as expenseList (e.g. trade) so a scoped analytics call only sees the matching rows", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
});

describe("expense repository — embedding cascade invariant", () => {
  const ctx = withTestDb();

  // Full cascade coverage (seeded embedding row -> soft-deleted + orphan
  // check) lives in
  // repo/inventory/embedding-cascade-invariant.integration.test.ts's
  // "deleteExpenses leaves no orphan" case. This just re-confirms the
  // no-orphan invariant holds from this file's own delete path too.
  it("deleteExpenses leaves no orphaned EntityEmbedding rows", async () => {
    const expenseRow = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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

// The product bridge: an expense optionally points at the product it bought,
// and a *negative* expense on the same product records the exit (sale, return,
// or a 0-cost disposal). Money and ownership have deliberately separate
// authorities — these cases pin the read side of that.
describe("expense repository — product bridge", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("round-trips productId/vendor and resolves productName", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge miter saw" }),
      ctx.actor,
    );

    const created = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "millwork",
        costType: "tools",
        name: "miter saw",
        productId: product.id,
        vendor: "Home Depot",
        cost: 180,
      }),
      ctx.actor,
    );

    const read = await getExpenseByID(ctx.db, created.id);
    expect(read).toMatchObject({
      productId: product.id,
      productName: "bridge miter saw",
      vendor: "Home Depot",
    });

    const cleared = await updateExpense(
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

    const bought = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "flooring",
        costType: "tools",
        name: "tile saw",
        productId: product.id,
        cost: 180,
      }),
      ctx.actor,
    );
    const sold = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
    // Net basis is the sum of the linked rows — the derivation the product page
    // renders, with nothing stored.
    expect(data.reduce((sum, p) => sum + (p.cost ?? 0), 0)).toBe(30);
  });

  it("deleteProducts rejects a product still referenced by a live expense", async () => {
    // This used to be permitted deliberately — a product referenced only by
    // expenses deleted fine, and the dangling link degraded to a null
    // display name via resolveLiveJoinName. That was reversed
    // (PRODUCT_HAS_EXPENSES, mirroring PRODUCT_HAS_INVENTORY): the ledger's
    // net cost and owned/sold window are derived from these rows, and a
    // nameless product would silently corrupt that derivation with no
    // restore path. See expense repository — productPresenceFilter's "has"
    // still counts an expense whose linked product was later soft-deleted"
    // below for the (still-real) dangling-link read path, produced by writing
    // deletedAt directly rather than through this now-blocked guard.
    const bridgeDoomedDrill = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge doomed drill" }),
      ctx.actor,
    );
    const created = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "tools",
        name: "doomed drill",
        productId: bridgeDoomedDrill.id,
      }),
      ctx.actor,
    );

    await expect(
      deleteProducts(ctx.db, [bridgeDoomedDrill.id], ctx.actor),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: { reason: "PRODUCT_HAS_EXPENSES" },
    });

    const read = await getExpenseByID(ctx.db, created.id);
    expect(read.productId).toBe(bridgeDoomedDrill.id);
    expect(read.productName).toBe("bridge doomed drill");
  });

  it("still matches name search when vendor is null", async () => {
    // Regression gate: vendor must never join the `search` term, because
    // buildSearchConditions ANDs its searchFilters — `name ILIKE q AND vendor
    // ILIKE q` would return nothing for the (overwhelming) null-vendor rows.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
    const lumber = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
    // The class of bug the old exact-string match existed to prevent ("Amazon
    // (254)" also dragging in "Amazon Business") is gone by construction now:
    // two names are two rows in the `Vendor` roster, so the filter compares
    // primary keys and there is no substring to leak through.
    const prime = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "prime order",
        vendor: "Amazon",
      }),
      ctx.actor,
    );
    const business = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
      createExpense(
        ctx.db,
        expenseCreateInput.parse({
          trade: "other",
          costType: "materials",
          name,
          vendor,
        }),
        ctx.actor,
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

  it("finds chargeless rows via vendorPresenceFilter, and ORs with a selection", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "cash at the yard",
      }),
      ctx.actor,
    );
    const tileSaw = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "tile saw",
        vendor: "Tool Nirvana",
      }),
      ctx.actor,
    );

    // "No vendor" and "no charge" are the same predicate — `purchase.vendorId`
    // is NOT NULL, so a line either has a charge (and therefore a vendor) or has
    // neither.
    const none = await expenseList(
      ctx.db,
      { vendorPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(none.data.map((p) => p.name)).toEqual(["cash at the yard"]);

    // OR, not AND — "Tool Nirvana or nothing recorded" is one filter.
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

describe("expense repository — productPresenceFilter", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it('"has" returns only expenses with a linked product', async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "presence linked drill" }),
      ctx.actor,
    );
    const linked = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
        trade: "other",
        costType: "tools",
        name: "linked sander expense",
        productId: product.id,
      }),
      ctx.actor,
    );
    const unlinked = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
    // deliberately includes rows whose product was soft-deleted afterward —
    // those read back with productId set and productName null.
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
    const expense = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
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
      .where(eq(product.id, doomedRouter.id));

    const hasFiltered = await expenseList(
      ctx.db,
      { productPresenceFilter: "has" },
      [],
      pagination,
    );
    expect(hasFiltered.data.map((p) => p.id)).toContain(expense.id);
    const stillLinked = hasFiltered.data.find((p) => p.id === expense.id);
    expect(stillLinked?.productId).toBe(doomedRouter.id);
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

/**
 * Charge grouping — what replaced `getExpenseOrderSiblings`. The group is a
 * parent link (`expense.purchaseId → Purchase`) resolved on write by
 * `resolveCharge`, not a `(vendor, orderId)` string match reconstructed on read,
 * so these pin where `createExpense` files a line and what
 * `getPurchaseExpenses` reads back out of one charge.
 */
describe("expense repository — charge grouping", () => {
  const ctx = withTestDb();

  const chargeLine = (
    name: string,
    vendor: string | null,
    orderId: string | null = null,
  ) =>
    expenseCreateInput.parse({
      trade: "other",
      costType: "materials",
      name,
      cost: 10,
      vendor,
      orderId,
    });

  it("files two lines of one order onto ONE charge, where they see each other", async () => {
    const orderId = "111-charge-0000001";
    const first = await createExpense(
      ctx.db,
      chargeLine("order line one", "Amazon", orderId),
      ctx.actor,
    );
    const second = await createExpense(
      ctx.db,
      chargeLine("order line two", "Amazon", orderId),
      ctx.actor,
    );
    // Same order id under a DIFFERENT vendor is a different charge — an order id
    // is only unique within a vendor, which is exactly what the partial-unique
    // `(vendorId, orderId)` index encodes.
    const collision = await createExpense(
      ctx.db,
      chargeLine("same id, other retailer", "Home Depot", orderId),
      ctx.actor,
    );
    // Same vendor, different order — the other axis.
    const otherOrder = await createExpense(
      ctx.db,
      chargeLine("different order", "Amazon", "111-charge-0000002"),
      ctx.actor,
    );

    expect(purchaseIdOf(first)).toBe(purchaseIdOf(second));
    expect(purchaseIdOf(collision)).not.toBe(purchaseIdOf(first));
    expect(purchaseIdOf(otherOrder)).not.toBe(purchaseIdOf(first));

    // Every line of the charge, source row included — the total needs it, and
    // the detail section filters itself out (see `expense.chargeSiblings`).
    const lines = await getPurchaseExpenses(ctx.db, purchaseIdOf(first));
    expect(lines.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
    expect(lines.map((p) => p.id)).not.toContain(collision.id);
    expect(lines.map((p) => p.id)).not.toContain(otherOrder.id);
  });

  it("keeps two order-less buys from one vendor on SEPARATE charges", async () => {
    const walkInA = await createExpense(
      ctx.db,
      chargeLine("counter sale a", "Tool Nirvana"),
      ctx.actor,
    );
    const walkInB = await createExpense(
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
      (await getPurchaseExpenses(ctx.db, purchaseIdOf(walkInA))).map(
        (p) => p.id,
      ),
    ).toEqual([walkInA.id]);
    expect(
      (await getPurchaseExpenses(ctx.db, purchaseIdOf(walkInB))).map(
        (p) => p.id,
      ),
    ).toEqual([walkInB.id]);
  });

  it("gives a line with no vendor no charge at all", async () => {
    // An order id alone can't name a transaction (they're only unique per
    // vendor), so a vendorless line gets no charge rather than an unidentifiable
    // one — and the detail page's charge section stays off for it.
    const loose = await createExpense(
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
    const keep = await createExpense(
      ctx.db,
      chargeLine("surviving line", "Amazon", orderId),
      ctx.actor,
    );
    const doomed = await createExpense(
      ctx.db,
      chargeLine("deleted line", "Amazon", orderId),
      ctx.actor,
    );

    expect(
      (await getPurchaseExpenses(ctx.db, purchaseIdOf(keep))).map((p) => p.id),
    ).toContain(doomed.id);

    await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

    expect(
      (await getPurchaseExpenses(ctx.db, purchaseIdOf(keep))).map((p) => p.id),
    ).toEqual([keep.id]);
  });
});

/**
 * Charge resolution on UPDATE — `resolveCharge`'s `current` argument, which the
 * create path never exercises.
 *
 * An update is the side where a name-to-charge resolution can do damage rather
 * than just be wrong: the row is already ON a charge, so a careless re-resolve
 * re-points it and leaves the old charge behind. Nothing sweeps up empty charges
 * and there is no restore path, so a leak there is permanent — that's the bug
 * these pin.
 */
describe("expense repository — charge resolution on update", () => {
  const ctx = withTestDb();
  const page = { pageIndex: 0, pageSize: 100 };

  const line = (
    name: string,
    vendor: string | null,
    orderId: string | null = null,
  ) => makeExpenseInput({ name, cost: 10, vendor, orderId });

  /** Live charges belonging to one vendor — the orphan detector below. */
  const chargeCount = async (id: VendorId) =>
    (await purchaseList(ctx.db, { vendorId: id }, [], page)).count;

  it("re-writing the SAME vendor onto an order-less row mints no second charge", async () => {
    // THE regression gate. `(vendorId, null)` is not unique, so
    // `findOrCreatePurchase` cannot dedupe an order-less charge — it always
    // inserts. Without `resolveCharge`'s `current` short-circuit, every save of
    // an unchanged vendor (an inline edit that re-submits the same value, a
    // re-import of the same row) created a fresh charge, re-pointed the expense
    // at it, and orphaned the previous one — `statedTotal` and attached
    // documents included.
    const counterSale = await createExpense(
      ctx.db,
      line("counter sale", "Tool Nirvana"),
      ctx.actor,
    );
    const vendorId = vendorIdOf(counterSale);
    const chargeBefore = purchaseIdOf(counterSale);
    expect(await chargeCount(vendorId)).toBe(1);

    const rewritten = await updateExpense(
      ctx.db,
      counterSale.id,
      { vendor: "Tool Nirvana" },
      ctx.actor,
    );

    expect(rewritten.purchaseId).toBe(chargeBefore);
    expect(await chargeCount(vendorId)).toBe(1);

    // Idempotent again when the unchanged order id is restated alongside it —
    // the `current.orderId === requestedOrderId` arm of the same guard.
    const withOrder = await createExpense(
      ctx.db,
      line("online order", "Tool Nirvana", "#11325"),
      ctx.actor,
    );
    const restated = await updateExpense(
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
    const keep = await createExpense(
      ctx.db,
      line("stays on the order", "Amazon", orderId),
      ctx.actor,
    );
    const leaving = await createExpense(
      ctx.db,
      line("mis-filed line", "Amazon", orderId),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(keep);
    expect(purchaseIdOf(leaving)).toBe(chargeId);

    const detached = await updateExpense(
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
    const charge = await getPurchaseByID(ctx.db, chargeId);
    expect(charge.orderId).toBe(orderId);
    expect(
      (await getPurchaseExpenses(ctx.db, chargeId)).map((p) => p.id),
    ).toEqual([keep.id]);
  });

  it("changing the vendor moves the line to the other vendor's charge, carrying its order id", async () => {
    const orderId = "WN-moved-0001";
    const misattributed = await createExpense(
      ctx.db,
      line("bought at the wrong store", "Lowe's", orderId),
      ctx.actor,
    );
    const wrongCharge = purchaseIdOf(misattributed);

    const corrected = await updateExpense(
      ctx.db,
      misattributed.id,
      { vendor: "Home Depot" },
      ctx.actor,
    );

    expect(corrected.purchaseId).not.toBe(wrongCharge);
    expect(corrected.vendor).toBe("Home Depot");
    // An omitted `orderId` means "leave it alone" — the receipt number is still
    // the receipt number, so it rides along to the new vendor's charge
    // (`current?.orderId ?? null`).
    expect(corrected.orderId).toBe(orderId);

    // The vacated charge is FOLDED into the new one, not left line-less: `resolveCharge` folds when the old charge loses its last line, so its statedTotal/notes/date and documents carry over rather than stranding. Same rule as detaching above.
    expect(await getPurchaseExpenses(ctx.db, wrongCharge)).toEqual([]);
  });

  it("adding an order id moves an order-less line onto the (vendor, orderId) charge, joining a sibling already there", async () => {
    const orderId = "111-adopt-0000001";
    const alreadyFiled = await createExpense(
      ctx.db,
      line("first line of the order", "Amazon", orderId),
      ctx.actor,
    );
    const loose = await createExpense(
      ctx.db,
      line("second line, order id not known yet", "Amazon"),
      ctx.actor,
    );
    // Two separate charges to start with — an order-less buy can't dedupe.
    expect(purchaseIdOf(loose)).not.toBe(purchaseIdOf(alreadyFiled));

    const adopted = await updateExpense(
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
      (await getPurchaseExpenses(ctx.db, purchaseIdOf(alreadyFiled)))
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
    const alreadyFiled = await createExpense(
      ctx.db,
      line("first line of the order", "Amazon", orderId),
      ctx.actor,
    );
    const loose = await createExpense(
      ctx.db,
      line("order id typed in later", "Amazon"),
      ctx.actor,
    );

    const adopted = await updateExpense(
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
    const anchor = await createExpense(
      ctx.db,
      line("known charge anchor", "eBay", "eb-shortcircuit-1"),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(anchor);
    const stray = await createExpense(
      ctx.db,
      line("stray line", null),
      ctx.actor,
    );

    const attached = await updateExpense(
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
    const cash = await createExpense(
      ctx.db,
      line("cash, no receipt", null),
      ctx.actor,
    );
    expect(cash.purchaseId).toBeNull();
    const chargesBefore = (await purchaseList(ctx.db, {}, [], page)).count;

    const updated = await updateExpense(
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

  // The OTHER half of door 2. The sibling test above ("adopts an order id
  // written on its own") drives `renameChargeOrderId` into its collision arm and
  // falls through to the existing charge; this one drives the arm that actually
  // renames, which is the COMMON path — correcting a typo'd order number on a
  // charge whose only line is the row being edited.
  it("corrects a typo'd order id IN PLACE on a single-line charge, keeping its statedTotal", async () => {
    const typo = await createExpense(
      ctx.db,
      line("receipt with a typo", "Home Depot", "WN6344646"),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(typo);
    const vendorId = vendorIdOf(typo);
    // The two things a re-minted charge would strand. `statedTotal` is the
    // reconciliation cue the whole Purchase table exists to hold.
    await updatePurchase(
      ctx.db,
      { id: chargeId, data: { statedTotal: 10, notes: "invoice on file" } },
      ctx.actor,
    );

    const fixed = await updateExpense(
      ctx.db,
      typo.id,
      { orderId: "WN63446464" },
      ctx.actor,
    );

    // SAME charge, renamed — not a fresh one with the old left behind.
    expect(fixed.purchaseId).toBe(chargeId);
    expect(fixed.orderId).toBe("WN63446464");
    expect(await chargeCount(vendorId)).toBe(1);
    const charge = await getPurchaseByID(ctx.db, chargeId);
    expect(charge.statedTotal).toBe(10);
    expect(charge.notes).toBe("invoice on file");

    // Audited on the CHARGE: the rename returns `undefined` to `resolveCharge`,
    // so `expenseCrud.update` sees no column change and emits nothing — without
    // `renameChargeOrderId`'s own entry the edit would leave no trace anywhere.
    const chargeAudit = await getAuditLog(ctx.db, {
      entityType: "purchase",
      entityId: chargeId,
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

    // Clearing it is the same in-place rename with no collision check to make —
    // `(vendorId, null)` isn't in the partial-unique index at all.
    const cleared = await updateExpense(
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
    const doomed = await createExpense(
      ctx.db,
      line("about to be deleted", null),
      ctx.actor,
    );
    const chargesBefore = (await purchaseList(ctx.db, {}, [], page)).count;
    const vendorsBefore = (await vendorOptions(ctx.db)).length;

    await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

    // A brand-new vendor AND a brand-new charge, so both sides of the resolve
    // have something to leak.
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

    // And no audit entry for a write that never landed.
    const audit = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: doomed.id,
      limit: 20,
    });
    expect(audit.entries.filter((e) => e.action === "update")).toEqual([]);
  });

  it("refuses an explicit purchaseId that points at a soft-deleted charge", async () => {
    // An FK proves the charge row exists, not that it isn't tombstoned, and an
    // explicit `purchaseId` skips `resolveCharge` entirely — so
    // `assertPurchaseLive` is the only thing between a direct API call and spend
    // filed against a dead charge.
    const anchor = await createExpense(
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

    // Same guard on the update short-circuit: `rest.purchaseId` never passes
    // through `resolveCharge`, so it is checked separately or it goes in unchecked.
    const stray = await createExpense(ctx.db, line("stray", null), ctx.actor);
    await expect(
      updateExpense(ctx.db, stray.id, { purchaseId: deadChargeId }, ctx.actor),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });
    expect((await getExpenseByID(ctx.db, stray.id)).purchaseId).toBeNull();

    // A charge id that never existed is refused by the same assert.
    await expect(
      updateExpense(
        ctx.db,
        stray.id,
        {
          purchaseId: unsafePurchaseId("00000000-0000-0000-0000-000000000000"),
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });
  });
});

/**
 * `orderIdPresenceFilter` — presence resolved through the CHARGE, not a column
 * on the row. See `orderIdPresence` in repo/expense/lookup.ts.
 */
describe("expense repository — orderIdPresenceFilter", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  /** The three states the filter has to tell apart. */
  const seed = async () => {
    const hasOrderId = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "amazon order line",
        vendor: "Amazon",
        orderId: "111-presence-0000001",
      }),
      ctx.actor,
    );
    // A contractor's progress payment: a real charge, but the vendor never
    // issued an order number for it.
    const chargeWithoutOrderId = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "progress payment", vendor: "Flow Form" }),
      ctx.actor,
    );
    // No charge at all — cash at the yard, no vendor recorded.
    const noCharge = await createExpense(
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
    // `orderIdPresence` returns undefined for an absent filter rather than an
    // always-true clause, so an unfiltered ledger query still sees everything.
    const { hasOrderId, chargeWithoutOrderId, noCharge } = await seed();

    const { data } = await expenseList(ctx.db, {}, [], pagination);
    expect(data.map((p) => p.id).sort()).toEqual(
      [hasOrderId.id, chargeWithoutOrderId.id, noCharge.id].sort(),
    );
  });
});

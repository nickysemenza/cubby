import { unsafeProjectId, unsafePurchaseId } from "@cubby/schemas/identifiers";
import {
  projectCreateInput,
  purchaseCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { purchaseRouter } from "~/server/api/routers/purchase";
import { createTestCaller } from "~/server/api/trpc";
import { getAuditLog } from "~/server/repo/audit-log";
import { findOrphanedEntityEmbeddings } from "~/server/repo/entity-embedding";
import { createProduct, deleteProducts } from "~/server/repo/product";
import { createProject, deleteProjects } from "~/server/repo/project";
import {
  createPurchase,
  deletePurchases,
  getPurchaseByID,
  movePurchases,
  purchaseAnalytics,
  purchaseList,
  updatePurchase,
} from "~/server/repo/purchase";
import { makeProductInput } from "~/server/repo/repo.fixtures";

// NB: project rollup contribution (spend/purchaseCount/subtree) and
// project-delete-blocking-on-live-purchases are already covered in
// project.integration.test.ts ("rolls up spend..." and "blocks deletion
// while live tasks or purchases still reference the project") — not
// re-asserted here.

describe("purchase repository — CRUD", () => {
  const ctx = withTestDb();

  it("creates, reads (with projectName join), updates (incl. clearing date/projectId), and deletes", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "purchase crud project" }),
      ctx.actor,
    );

    const created = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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

    const read = await getPurchaseByID(ctx.db, created.id);
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

    const updated = await updatePurchase(
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

    await deletePurchases(ctx.db, [created.id], ctx.actor);

    await expect(getPurchaseByID(ctx.db, created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });

    const { data } = await purchaseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(data.map((p) => p.id)).not.toContain(created.id);
  });
});

describe("purchase repository — purchaseList filters", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("filters by search, costType, trade, future", async () => {
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "copper pipe",
        future: false,
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "electrical",
        costType: "tools",
        name: "wire strippers",
        future: true,
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "plumbing",
        costType: "services",
        name: "plumber visit",
        future: false,
      }),
      ctx.actor,
    );

    const bySearch = await purchaseList(
      ctx.db,
      { search: "copper" },
      [],
      pagination,
    );
    expect(bySearch.data.map((p) => p.name)).toEqual(["copper pipe"]);

    const byCostType = await purchaseList(
      ctx.db,
      { costType: "tools" },
      [],
      pagination,
    );
    expect(byCostType.data.map((p) => p.name)).toEqual(["wire strippers"]);

    const byTrade = await purchaseList(
      ctx.db,
      { trade: "plumbing" },
      [],
      pagination,
    );
    expect(new Set(byTrade.data.map((p) => p.name))).toEqual(
      new Set(["copper pipe", "plumber visit"]),
    );

    const futureOnly = await purchaseList(
      ctx.db,
      { future: true },
      [],
      pagination,
    );
    expect(futureOnly.data.map((p) => p.name)).toEqual(["wire strippers"]);

    const notFuture = await purchaseList(
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
      [parent, "parent purchase"],
      [child, "child purchase"],
      [grandchild, "grandchild purchase"],
      [other, "unrelated purchase"],
    ] as const) {
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          trade: "other",
          costType: "materials",
          name,
          projectId: proj.id,
        }),
        ctx.actor,
      );
    }

    const directOnly = await purchaseList(
      ctx.db,
      { projectId: parent.id },
      [],
      pagination,
    );
    expect(directOnly.data.map((p) => p.name)).toEqual(["parent purchase"]);

    const subtree = await purchaseList(
      ctx.db,
      { projectId: parent.id, includeSubProjects: true },
      [],
      pagination,
    );
    expect(new Set(subtree.data.map((p) => p.name))).toEqual(
      new Set(["parent purchase", "child purchase", "grandchild purchase"]),
    );
    expect(subtree.data.map((p) => p.name)).not.toContain("unrelated purchase");
  });

  it("filters by dateFrom/dateTo (inclusive boundary, outside window, null-date excluded)", async () => {
    const inWindow = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "in window",
        date: "2026-02-15",
      }),
      ctx.actor,
    );
    const lowerBoundary = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "on lower boundary",
        date: "2026-02-01",
      }),
      ctx.actor,
    );
    const upperBoundary = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "on upper boundary",
        date: "2026-02-28",
      }),
      ctx.actor,
    );
    const beforeWindow = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "before window",
        date: "2026-01-01",
      }),
      ctx.actor,
    );
    const afterWindow = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "after window",
        date: "2026-03-01",
      }),
      ctx.actor,
    );
    const nullDate = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "no date (future)",
        future: true,
      }),
      ctx.actor,
    );
    expect(nullDate.date).toBeNull();

    const windowed = await purchaseList(
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
    const fromOnly = await purchaseList(
      ctx.db,
      { dateFrom: "2026-02-28" },
      [],
      pagination,
    );
    expect(new Set(fromOnly.data.map((p) => p.id))).toEqual(
      new Set([upperBoundary.id, afterWindow.id]),
    );

    // dateTo alone — open lower bound.
    const toOnly = await purchaseList(
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
    const matches = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "wrong date",
        projectId: project.id,
        date: "2026-01-01",
        future: false,
      }),
      ctx.actor,
    );

    const result = await purchaseList(
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

describe("purchase repository — sorting/pagination", () => {
  const ctx = withTestDb();

  it("defaults to sorting by date, supports multi-sort, and reports correct total count with a small page size", async () => {
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "b purchase",
        cost: 10,
        date: "2026-01-02",
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "a purchase",
        cost: 20,
        date: "2026-01-01",
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "a purchase second",
        cost: 5,
        date: "2026-01-01",
      }),
      ctx.actor,
    );

    // Default sort: date.
    const byDate = await purchaseList(
      ctx.db,
      {},
      [{ orderBy: "date", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(byDate.data[0]?.date).toBe("2026-01-01");
    expect(byDate.data[2]?.date).toBe("2026-01-02");

    // Multi-sort: date asc, then cost desc as a tiebreak among the two
    // same-day rows.
    const multiSort = await purchaseList(
      ctx.db,
      {},
      [
        { orderBy: "date", direction: "asc" },
        { orderBy: "cost", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(multiSort.data.map((p) => p.name)).toEqual([
      "a purchase",
      "a purchase second",
      "b purchase",
    ]);

    // Small page size — count still reflects the full unpaginated total.
    const { data: page, count } = await purchaseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 2,
    });
    expect(page).toHaveLength(2);
    expect(count).toBe(3);
  });
});

describe("purchase router", () => {
  const ctx = withTestDb();

  it("chartData returns the filtered set", async () => {
    const caller = createTestCaller(purchaseRouter, ctx.db);
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "chart match",
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "electrical",
        costType: "materials",
        name: "chart non-match",
      }),
      ctx.actor,
    );

    const result = await caller.chartData({ trade: "plumbing" });
    expect(result.map((p) => p.name)).toEqual(["chart match"]);
  });

  it("bulkMove moves purchases to another project and to the inbox (null), returning items + sideEffects", async () => {
    const caller = createTestCaller(purchaseRouter, ctx.db);
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
    const p1 = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "bulk move purchase 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const p2 = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "bulk move purchase 2",
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

    // purchaseBulkMoveInput allows a null projectId — moves to the inbox.
    const toInbox = await caller.bulkMove({
      ids: [p1.id, p2.id],
      projectId: null,
    });
    expect(toInbox.items.every((i) => i.projectId === null)).toBe(true);
    expect(toInbox.sideEffects).toBeDefined();
  });
});

describe("purchase repository — movePurchases", () => {
  const ctx = withTestDb();

  it("moves rows to the new projectId and writes an audit entry per changed row", async () => {
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move purchases a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move purchases b" }),
      ctx.actor,
    );
    const p1 = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "move me 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const p2 = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "move me 2",
        projectId: projectA.id,
      }),
      ctx.actor,
    );

    const moved = await movePurchases(
      ctx.db,
      { ids: [p1.id, p2.id], projectId: projectB.id },
      ctx.actor,
    );
    expect(moved.map((p) => p.projectId)).toEqual([projectB.id, projectB.id]);

    const auditP1 = await getAuditLog(ctx.db, {
      entityType: "purchase",
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
      projectCreateInput.parse({ name: "move purchases untouched a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move purchases untouched b" }),
      ctx.actor,
    );
    const live = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "still live",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const deleted = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "soon deleted",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    await deletePurchases(ctx.db, [deleted.id], ctx.actor);

    const moved = await movePurchases(
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
      projectCreateInput.parse({ name: "move purchases reject source" }),
      ctx.actor,
    );
    const purchaseRow = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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
      movePurchases(
        ctx.db,
        { ids: [purchaseRow.id], projectId: bogusProjectId },
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
      movePurchases(
        ctx.db,
        { ids: [purchaseRow.id], projectId: deletedProject.id },
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
      projectCreateInput.parse({ name: "move purchases noop project" }),
      ctx.actor,
    );
    const bogusId = unsafePurchaseId("00000000-0000-0000-0000-000000000000");

    const moved = await movePurchases(
      ctx.db,
      { ids: [bogusId], projectId: project.id },
      ctx.actor,
    );
    expect(moved).toEqual([]);
  });
});

describe("purchase repository — purchaseAnalytics", () => {
  const ctx = withTestDb();

  it("aggregates match manual arithmetic, omits empty categories, and stays consistent with purchaseList under the same filter", async () => {
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
    const p1 = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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
    const p2 = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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
    const p3 = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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
    const p4 = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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
    const result = await purchaseAnalytics(ctx.db, filters);

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

    // --- core invariant: analytics totals agree with purchaseList's visible
    // rows under the SAME filter — sum purchaseList's `cost` column and
    // compare against summary.net (both should equal 160). ---
    const { data: listedRows } = await purchaseList(ctx.db, filters, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    expect(listedRows.map((p) => p.id).sort()).toEqual(
      [p1.id, p2.id, p3.id, p4.id].sort(),
    );
    const summedCost = listedRows.reduce((sum, p) => sum + (p.cost ?? 0), 0);
    expect(summedCost).toBe(result.summary.net);
  });

  it("applies the same filters as purchaseList (e.g. trade) so a scoped analytics call only sees the matching rows", async () => {
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "analytics filter match",
        cost: 10,
        future: false,
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "electrical",
        costType: "materials",
        name: "analytics filter non-match",
        cost: 999,
        future: false,
      }),
      ctx.actor,
    );

    const result = await purchaseAnalytics(ctx.db, {
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

describe("purchase repository — embedding cascade invariant", () => {
  const ctx = withTestDb();

  // Full cascade coverage (seeded embedding row -> soft-deleted + orphan
  // check) lives in
  // repo/inventory/embedding-cascade-invariant.integration.test.ts's
  // "deletePurchases leaves no orphan" case. This just re-confirms the
  // no-orphan invariant holds from this file's own delete path too.
  it("deletePurchases leaves no orphaned EntityEmbedding rows", async () => {
    const purchaseRow = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "embedding cascade check",
      }),
      ctx.actor,
    );

    await deletePurchases(ctx.db, [purchaseRow.id], ctx.actor);

    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });
});

// The product bridge: a purchase optionally points at the product it bought,
// and a *negative* purchase on the same product records the exit (sale, return,
// or a 0-cost disposal). Money and ownership have deliberately separate
// authorities — these cases pin the read side of that.
describe("purchase repository — product bridge", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("round-trips productId/vendor and resolves productName", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge miter saw" }),
      ctx.actor,
    );

    const created = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "millwork",
        costType: "tools",
        name: "miter saw",
        productId: product.id,
        vendor: "Home Depot",
        cost: 180,
      }),
      ctx.actor,
    );

    const read = await getPurchaseByID(ctx.db, created.id);
    expect(read).toMatchObject({
      productId: product.id,
      productName: "bridge miter saw",
      vendor: "Home Depot",
    });

    const cleared = await updatePurchase(
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

    const bought = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "flooring",
        costType: "tools",
        name: "tile saw",
        productId: product.id,
        cost: 180,
      }),
      ctx.actor,
    );
    const sold = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "flooring",
        costType: "tools",
        name: "sold tile saw",
        productId: product.id,
        cost: -150,
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "flooring",
        costType: "materials",
        name: "unrelated thinset",
      }),
      ctx.actor,
    );

    const { data, count } = await purchaseList(
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

  it("keeps productId but nulls productName once the product is soft-deleted", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge doomed drill" }),
      ctx.actor,
    );
    const created = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "tools",
        name: "doomed drill",
        productId: product.id,
      }),
      ctx.actor,
    );

    // Deliberately asymmetric with project deletion, which a live purchase
    // blocks: a product referenced only by purchases deletes fine, and the
    // dangling link degrades to a null display name via resolveLiveJoinName.
    await deleteProducts(ctx.db, [product.id], ctx.actor);

    const read = await getPurchaseByID(ctx.db, created.id);
    expect(read.productId).toBe(product.id);
    expect(read.productName).toBeNull();
  });

  it("still matches name search when vendor is null", async () => {
    // Regression gate: vendor must never join the `search` term, because
    // buildSearchConditions ANDs its searchFilters — `name ILIKE q AND vendor
    // ILIKE q` would return nothing for the (overwhelming) null-vendor rows.
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "vendorless grommets",
      }),
      ctx.actor,
    );

    const { data } = await purchaseList(
      ctx.db,
      { search: "grommets" },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toContain("vendorless grommets");
  });

  it("filters by vendor independently of search", async () => {
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "lumber run",
        vendor: "Ganahl Lumber",
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "screws",
        vendor: "Home Depot",
      }),
      ctx.actor,
    );

    const { data } = await purchaseList(
      ctx.db,
      { vendor: "ganahl" },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toEqual(["lumber run"]);
  });
});

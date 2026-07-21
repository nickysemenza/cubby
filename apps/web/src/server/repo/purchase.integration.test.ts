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
import { createProject, deleteProjects } from "~/server/repo/project";
import {
  createPurchase,
  deletePurchases,
  getPurchaseByID,
  movePurchases,
  purchaseList,
  updatePurchase,
} from "~/server/repo/purchase";

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

import {
  projectCreateInput,
  projectToolMatrixInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { auditLog, projectToolUsage } from "~/server/db/schema";
import { getDb, notDeleted } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
import { deleteProducts, updateProduct } from "./product";
import { createProject, deleteProjects, getProjectByID } from "./project";
import { projectToolMatrix } from "./project/tool-matrix";
import {
  attachProjectResources,
  detachProjectResources,
  listProductProjectUses,
  listProjectResources,
  setProductProjectUses,
  setProjectToolUsage,
  suggestProjectTools,
} from "./project/tools";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { createTask } from "./task";

describe("project reusable resources", () => {
  const ctx = withTestDb();

  it("records exact-project reuse and calculates net lifetime cost per use", async () => {
    const { output: kitchen, entityId: kitchenId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Kitchen refresh" }),
      ctx.actor,
    );
    const { output: yard, entityId: yardId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Yard work" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Track saw",
        category: "tools",
      }),
      ctx.actor,
    );

    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Track saw",
        projectId: kitchen.id,
        productId: tool.id,
        costType: "tools",
        cost: 300,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Track saw refund",
        projectId: kitchen.id,
        productId: tool.id,
        costType: "tools",
        cost: -50,
      }),
      ctx.actor,
    );

    await expect(
      attachProjectResources(ctx.db, kitchenId, [tool.entityId], ctx.actor),
    ).resolves.toEqual({ changed: 1, attached: 1 });
    await expect(
      attachProjectResources(ctx.db, kitchenId, [tool.entityId], ctx.actor),
    ).resolves.toEqual({ changed: 0, attached: 1 });
    await attachProjectResources(ctx.db, yardId, [tool.entityId], ctx.actor);

    await expect(listProjectResources(ctx.db, kitchenId)).resolves.toEqual([
      expect.objectContaining({
        productId: tool.id,
        category: "tools",
        projectPurchaseCost: 300,
        sharedWindow: null,
        grossLifetimeAcquisitionCost: 300,
        netLifetimeCost: 250,
        projectUseCount: 2,
        costPerProjectUse: 125,
      }),
    ]);
    await expect(
      listProductProjectUses(ctx.db, tool.entityId),
    ).resolves.toMatchObject({
      productId: tool.id,
      category: "tools",
      grossLifetimeAcquisitionCost: 300,
      netLifetimeCost: 250,
      projectUseCount: 2,
      costPerProjectUse: 125,
      projects: expect.arrayContaining([
        expect.objectContaining({
          projectId: kitchen.id,
          projectPurchaseCost: 300,
        }),
        expect.objectContaining({
          projectId: yard.id,
          projectPurchaseCost: 0,
        }),
      ]),
    });

    await expect(
      detachProjectResources(ctx.db, yardId, [tool.entityId], ctx.actor),
    ).resolves.toEqual({ changed: 1, attached: 0 });
    await expect(listProjectResources(ctx.db, kitchenId)).resolves.toEqual([
      expect.objectContaining({
        projectUseCount: 1,
        netLifetimeCost: 250,
        costPerProjectUse: 250,
      }),
    ]);
  });

  it("attaches software without inventory and rejects other Product categories", async () => {
    const { entityId: projectId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Design planning" }),
      ctx.actor,
    );
    const software = await createProduct(
      ctx.db,
      makeProductInput({ name: "AutoCAD LT", category: "software" }),
      ctx.actor,
    );
    const material = await createProduct(
      ctx.db,
      makeProductInput({ name: "Cleaning supplies", category: "supplies" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Design scale", category: "tools" }),
      ctx.actor,
    );

    await expect(
      attachProjectResources(ctx.db, projectId, [software.entityId], ctx.actor),
    ).resolves.toEqual({ changed: 1, attached: 1 });
    await expect(
      attachProjectResources(ctx.db, projectId, [software.entityId], ctx.actor),
    ).resolves.toEqual({ changed: 0, attached: 1 });
    await expect(
      attachProjectResources(ctx.db, projectId, [material.entityId], ctx.actor),
    ).rejects.toThrow(/tools or software/i);
    await attachProjectResources(ctx.db, projectId, [tool.entityId], ctx.actor);
    await updateProduct(
      ctx.db,
      tool.entityId,
      { category: "supplies" },
      ctx.actor,
    );

    await expect(listProjectResources(ctx.db, projectId)).resolves.toEqual([
      expect.objectContaining({ productId: software.id }),
    ]);
  });

  it("derives inclusive non-additive software spend and excludes direct subtree spend", async () => {
    const { output: completed, entityId: completedId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Completed design",
        status: "done",
        startDate: "2026-01-01",
        endDate: "2026-03-31",
      }),
      ctx.actor,
    );
    const { entityId: overlapId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Overlapping design",
        status: "done",
        startDate: "2026-01-01",
        endDate: "2026-03-31",
      }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Completed design child",
        parentProjectId: completed.id,
      }),
      ctx.actor,
    );
    const { output: other } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Household operations" }),
      ctx.actor,
    );
    const software = await createProduct(
      ctx.db,
      makeProductInput({ name: "AutoCAD LT", category: "software" }),
      ctx.actor,
    );
    const addCharge = (overrides: Parameters<typeof makeExpenseInput>[0]) =>
      createExpense(
        ctx.db,
        makeExpenseInput({
          name: "AutoCAD LT renewal",
          productId: software.id,
          costType: "services",
          trade: "planning",
          ...overrides,
        }),
        ctx.actor,
      );

    await addCharge({ date: "2026-01-01", cost: 70 });
    await addCharge({ date: "2026-03-31", cost: 70 });
    await addCharge({ date: "2026-02-15", cost: -10 });
    await addCharge({ date: "2026-02-20", cost: 30, projectId: other.id });
    await addCharge({ date: "2025-12-31", cost: 1000 });
    await addCharge({ date: "2026-04-01", cost: 1000 });
    await addCharge({ date: "2026-02-16", cost: 1000, future: true });
    await addCharge({ date: "2026-02-17", cost: null });
    const { output: deleted } = await addCharge({
      date: "2026-02-18",
      cost: 1000,
    });
    await deleteExpenses(ctx.db, [deleted.id], ctx.actor);

    const completedBeforeAttach = await getProjectByID(ctx.db, completedId);
    const overlapBeforeAttach = await getProjectByID(ctx.db, overlapId);
    await attachProjectResources(
      ctx.db,
      completedId,
      [software.entityId],
      ctx.actor,
    );
    await attachProjectResources(
      ctx.db,
      overlapId,
      [software.entityId],
      ctx.actor,
    );

    for (const projectId of [completedId, overlapId]) {
      await expect(
        listProjectResources(ctx.db, projectId, { today: "2026-08-03" }),
      ).resolves.toEqual([
        expect.objectContaining({
          productId: software.id,
          category: "software",
          grossLifetimeAcquisitionCost: null,
          costPerProjectUse: null,
          projectPurchaseCost: null,
          projectUseCount: 2,
          sharedWindow: {
            startDate: "2026-01-01",
            endDate: "2026-03-31",
            netCost: 160,
          },
        }),
      ]);
    }
    const completedAfterAttach = await getProjectByID(ctx.db, completedId);
    const overlapAfterAttach = await getProjectByID(ctx.db, overlapId);
    expect(completedAfterAttach.rollup).toEqual(completedBeforeAttach.rollup);
    expect(overlapAfterAttach.rollup).toEqual(overlapBeforeAttach.rollup);
    expect(completedAfterAttach.costEstimate).toBe(
      completedBeforeAttach.costEstimate,
    );
    expect(overlapAfterAttach.costEstimate).toBe(
      overlapBeforeAttach.costEstimate,
    );

    await addCharge({
      date: "2026-02-21",
      cost: 50,
      projectId: completed.id,
    });
    await addCharge({ date: "2026-02-22", cost: 60, projectId: child.id });

    await expect(
      listProjectResources(ctx.db, completedId, { today: "2026-08-03" }),
    ).resolves.toEqual([
      expect.objectContaining({
        sharedWindow: {
          startDate: "2026-01-01",
          endDate: "2026-03-31",
          netCost: 160,
        },
      }),
    ]);
    const productUses = await listProductProjectUses(
      ctx.db,
      software.entityId,
      { today: "2026-08-03" },
    );
    expect(productUses).toMatchObject({
      category: "software",
      grossLifetimeAcquisitionCost: null,
      costPerProjectUse: null,
      projectUseCount: 2,
    });
    expect(
      productUses.projects.find((row) => row.projectId === completed.id),
    ).toMatchObject({
      projectPurchaseCost: null,
      sharedWindow: { netCost: 160 },
    });
  });

  it("uses fixed today for live windows and requires complete done windows", async () => {
    const { entityId: liveId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Live design",
        status: "in_progress",
        startDate: "2026-01-01",
        endDate: "2026-02-01",
      }),
      ctx.actor,
    );
    const { entityId: noStartId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Undated live design" }),
      ctx.actor,
    );
    const { entityId: incompleteDoneId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Incomplete completed design",
        status: "done",
        startDate: "2026-01-01",
      }),
      ctx.actor,
    );
    const software = await createProduct(
      ctx.db,
      makeProductInput({ name: "Design subscription", category: "software" }),
      ctx.actor,
    );
    for (const [date, cost] of [
      ["2026-02-15", 20],
      ["2026-03-01", 30],
      ["2026-03-02", 40],
    ] as const) {
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: "Design subscription renewal",
          productId: software.id,
          costType: "services",
          trade: "planning",
          date,
          cost,
        }),
        ctx.actor,
      );
    }
    for (const projectId of [liveId, noStartId, incompleteDoneId]) {
      await attachProjectResources(
        ctx.db,
        projectId,
        [software.entityId],
        ctx.actor,
      );
    }

    await expect(
      listProjectResources(ctx.db, liveId, { today: "2026-03-01" }),
    ).resolves.toEqual([
      expect.objectContaining({
        sharedWindow: {
          startDate: "2026-01-01",
          endDate: "2026-03-01",
          netCost: 50,
        },
      }),
    ]);
    for (const projectId of [noStartId, incompleteDoneId]) {
      await expect(
        listProjectResources(ctx.db, projectId, { today: "2026-03-01" }),
      ).resolves.toEqual([expect.objectContaining({ sharedWindow: null })]);
    }
  });

  it("suggests expensive purchases and proven inventoried trade matches", async () => {
    const { output: target, entityId: targetId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Electrical update" }),
      ctx.actor,
    );
    const { output: historyA, entityId: historyAId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Garage wiring" }),
      ctx.actor,
    );
    const { entityId: historyBId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Shed wiring" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Install receptacles",
        projectId: target.id,
        trade: "electrical",
      }),
      ctx.actor,
    );

    const purchasedHere = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Circuit tracer",
        category: "tools",
      }),
      ctx.actor,
    );
    const reusedTradeTool = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Wire stripper",
        category: "tools",
      }),
      ctx.actor,
    );
    const oneUseCheapTool = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Cheap tester",
        category: "tools",
      }),
      ctx.actor,
    );
    const software = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Electrical design software",
        category: "software",
      }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Workshop tool wall" }),
      ctx.actor,
    );
    for (const product of [reusedTradeTool, oneUseCheapTool]) {
      await createInventoryEntry(
        ctx.db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    }

    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Circuit tracer",
        projectId: target.id,
        productId: purchasedHere.id,
        costType: "tools",
        trade: "electrical",
        cost: 160,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Electrical design software",
        projectId: target.id,
        productId: software.id,
        costType: "services",
        trade: "electrical",
        cost: 500,
      }),
      ctx.actor,
    );
    for (const product of [reusedTradeTool, oneUseCheapTool]) {
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: product.name,
          projectId: historyA.id,
          productId: product.id,
          costType: "tools",
          trade: "electrical",
          cost: 40,
        }),
        ctx.actor,
      );
    }
    await attachProjectResources(
      ctx.db,
      historyAId,
      [reusedTradeTool.entityId, oneUseCheapTool.entityId],
      ctx.actor,
    );
    await attachProjectResources(
      ctx.db,
      historyBId,
      [reusedTradeTool.entityId],
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Unlinked tool purchase",
        projectId: target.id,
        costType: "tools",
        trade: "electrical",
        cost: 125,
      }),
      ctx.actor,
    );

    const result = await suggestProjectTools(ctx.db, targetId);

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: purchasedHere.id,
          lane: "purchased_here",
          projectPurchaseCost: 160,
        }),
        expect.objectContaining({
          productId: reusedTradeTool.id,
          lane: "trade_match",
          matchedTrade: "electrical",
          projectUseCount: 2,
        }),
      ]),
    );
    expect(result.items.map((item) => item.productId)).not.toContain(
      oneUseCheapTool.id,
    );
    expect(result.items.map((item) => item.productId)).not.toContain(
      software.id,
    );
    expect(result.unlinkedExpensivePurchases).toEqual({
      count: 1,
      grossCost: 125,
    });
  });

  it("preserves use history on product delete and cascades it on project delete", async () => {
    const { output: project, entityId: projectId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Tool lifecycle project" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "History-only tool", category: "tools" }),
      ctx.actor,
    );
    await attachProjectResources(ctx.db, projectId, [tool.entityId], ctx.actor);

    await expect(
      deleteProducts(ctx.db, [tool.entityId], ctx.actor),
    ).rejects.toMatchObject({
      cause: { reason: "PRODUCT_HAS_PROJECT_USES" },
    });

    await deleteProjects(ctx.db, [project.id], ctx.actor);
    await expect(
      deleteProducts(ctx.db, [tool.entityId], ctx.actor),
    ).resolves.toBeUndefined();
  });
});

describe("project tool matrix", () => {
  const ctx = withTestDb();

  const matrixInput = (
    overrides: Partial<z.input<typeof projectToolMatrixInput>> = {},
  ) => projectToolMatrixInput.parse(overrides);

  const toolExpense = (
    overrides: Partial<Parameters<typeof makeExpenseInput>[0]> = {},
  ) =>
    makeExpenseInput({
      lineKind: "principal",
      costType: "tools",
      ...overrides,
    });

  it("derives trade from the largest qualifying expense and breaks ties deterministically", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Trade derivation" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Contested tool", category: "tools" }),
      ctx.actor,
    );

    // Two equal-cost electrical lines straddling a cheaper plumbing one: cost
    // DESC picks electrical, and date ASC settles the tie on the earlier line.
    for (const row of [
      { trade: "plumbing" as const, cost: 300, date: "2024-03-01" },
      { trade: "electrical" as const, cost: 500, date: "2024-06-01" },
      { trade: "electrical" as const, cost: 500, date: "2024-01-01" },
    ]) {
      await createExpense(
        ctx.db,
        toolExpense({
          name: `${row.trade} line`,
          projectId: project.id,
          productId: tool.id,
          ...row,
        }),
        ctx.actor,
      );
    }
    // Each of these outbids every real line and must still lose.
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Planned upgrade",
        productId: tool.id,
        trade: "metalworking",
        cost: 9999,
        future: true,
      }),
      ctx.actor,
    );
    // No non-principal case here: `createExpense` refuses to link a Product to
    // anything but a principal line, so the derivation's `lineKind` filter is
    // belt-and-braces rather than something a fixture can exercise.
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Partial refund",
        productId: tool.id,
        trade: "crafts",
        cost: -50,
      }),
      ctx.actor,
    );

    const first = await projectToolMatrix(ctx.db, matrixInput());
    expect(first.rows).toEqual([
      expect.objectContaining({
        productId: tool.id,
        trade: "electrical",
        groupKey: "electrical",
        // principal + non-future only, refund included: 300 + 500 + 500 - 50
        netLifetimeCost: 1250,
      }),
    ]);
    expect(first.groups).toEqual([
      { key: "electrical", label: "Electrical & Lighting", rowCount: 1 },
    ]);

    const second = await projectToolMatrix(ctx.db, matrixInput());
    expect(second.rows.map((row) => row.trade)).toEqual(
      first.rows.map((row) => row.trade),
    );
  });

  it("keeps a tool with no qualifying expense at floor 0 and drops it at the default floor", async () => {
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Gifted tool", category: "tools" }),
      ctx.actor,
    );

    // Guards the LEFT JOIN in the membership query: moving any expense
    // predicate to the WHERE turns it into an inner join and this row vanishes.
    const unfiltered = await projectToolMatrix(
      ctx.db,
      matrixInput({ minNetLifetimeCost: 0 }),
    );
    expect(unfiltered.rows).toEqual([
      expect.objectContaining({
        productId: tool.id,
        trade: null,
        groupKey: "",
        netLifetimeCost: 0,
      }),
    ]);
    expect(unfiltered.groups).toEqual([
      { key: "", label: "No trade signal", rowCount: 1 },
    ]);

    const floored = await projectToolMatrix(ctx.db, matrixInput());
    expect(floored.rows).toEqual([]);
    expect(floored.totals.matchingTools).toBe(0);
  });

  it("scopes columns by kind and orders them by their effective window", async () => {
    const projects = [
      { name: "Gamma garden", kind: "garden" as const, date: "2023-02-10" },
      { name: "Alpha reno", kind: "renovation" as const, date: "2024-01-10" },
      { name: "Beta shop", kind: "workshop" as const, date: "2025-05-10" },
    ];
    for (const spec of projects) {
      const { output } = await createProject(
        ctx.db,
        projectCreateInput.parse({ name: spec.name, kind: spec.kind }),
        ctx.actor,
      );
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: `${spec.name} spend`,
          projectId: output.id,
          cost: 25,
          date: spec.date,
        }),
        ctx.actor,
      );
    }

    const all = await projectToolMatrix(ctx.db, matrixInput());
    expect(all.columns.map((column) => column.projectName)).toEqual([
      "Gamma garden",
      "Alpha reno",
      "Beta shop",
    ]);
    expect(all.totals.matchingProjects).toBe(3);

    const scoped = await projectToolMatrix(
      ctx.db,
      matrixInput({ kinds: ["renovation", "workshop"] }),
    );
    expect(scoped.columns.map((column) => column.projectName)).toEqual([
      "Alpha reno",
      "Beta shop",
    ]);
    expect(scoped.totals.matchingProjects).toBe(2);

    const capped = await projectToolMatrix(
      ctx.db,
      matrixInput({ maxColumns: 1 }),
    );
    expect(capped.columns).toHaveLength(1);
    expect(capped.columns[0]?.projectName).toBe("Beta shop");
    expect(capped.totals.matchingProjects).toBe(3);
    expect(capped.columnPagination).toEqual({
      page: 1,
      pageSize: 1,
      pageCount: 3,
    });

    const secondPage = await projectToolMatrix(
      ctx.db,
      matrixInput({ maxColumns: 1, columnPage: 2 }),
    );
    expect(secondPage.columns[0]?.projectName).toBe("Alpha reno");
    expect(secondPage.columnPagination.page).toBe(2);

    const clamped = await projectToolMatrix(
      ctx.db,
      matrixInput({ maxColumns: 1, columnPage: 99 }),
    );
    expect(clamped.columns[0]?.projectName).toBe("Gamma garden");
    expect(clamped.columnPagination.page).toBe(3);

    const searched = await projectToolMatrix(
      ctx.db,
      matrixInput({ search: "Alpha" }),
    );
    expect(searched.columns.map((column) => column.projectName)).toEqual([
      "Alpha reno",
    ]);

    const completedIn2024 = await projectToolMatrix(
      ctx.db,
      matrixInput({ completionYear: "2024" }),
    );
    expect(completedIn2024.columns.map((column) => column.projectName)).toEqual(
      ["Alpha reno"],
    );
    expect(completedIn2024.filterOptions.completionYears).toEqual([
      "2025",
      "2024",
      "2023",
    ]);
  });

  it("marks purchased-here cells across every column in one read", async () => {
    const { output: rich, entityId: richId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Expensive buy" }),
      ctx.actor,
    );
    const { output: cheap, entityId: cheapId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Cheap buy" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Shared saw", category: "tools" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Saw",
        projectId: rich.id,
        productId: tool.id,
        cost: 300,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Saw blade run",
        projectId: cheap.id,
        productId: tool.id,
        cost: 40,
      }),
      ctx.actor,
    );

    const before = await projectToolMatrix(ctx.db, matrixInput());
    expect(before.cells).toEqual(
      expect.arrayContaining([
        {
          projectId: rich.id,
          productId: tool.id,
          state: "suggested",
          lane: "purchased_here",
          matchedTrade: null,
          projectPurchaseCost: 300,
        },
        // Below the floor, so not a suggestion — but still emitted, because a
        // purchase charged to this project is proof we owned the tool for it
        // and the client must not lock a cell it holds evidence for.
        {
          projectId: cheap.id,
          productId: tool.id,
          state: "purchase_evidence",
          lane: null,
          matchedTrade: null,
          projectPurchaseCost: 40,
        },
      ]),
    );
    expect(before.cells).toHaveLength(2);
    expect(before.totals.suggestedCells).toBe(1);

    // A sub-floor pair is never counted as a suggestion, and once it IS
    // attached the same query still reports what was bought there.
    await setProjectToolUsage(ctx.db, cheapId, tool.entityId, true, ctx.actor);
    const after = await projectToolMatrix(ctx.db, matrixInput());
    expect(after.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: cheap.id,
          state: "attached",
          projectPurchaseCost: 40,
        }),
      ]),
    );

    // And an attached pair is never also suggested.
    await setProjectToolUsage(ctx.db, richId, tool.entityId, true, ctx.actor);
    const attached = await projectToolMatrix(ctx.db, matrixInput());
    expect(attached.totals.suggestedCells).toBe(0);
    expect(attached.totals.attachedCells).toBe(2);
    expect(
      attached.rows.find((row) => row.productId === tool.id),
    ).toMatchObject({ visibleUseCount: 2, projectUseCount: 2 });
  });

  it("matches suggestProjectTools for a single column", async () => {
    const { output: target, entityId: targetId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Panel swap" }),
      ctx.actor,
    );
    const { output: history, entityId: historyId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Old wiring" }),
      ctx.actor,
    );
    const { entityId: history2Id } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Older wiring" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Pull circuits",
        projectId: target.id,
        trade: "electrical",
      }),
      ctx.actor,
    );

    const boughtHere = await createProduct(
      ctx.db,
      makeProductInput({ name: "Circuit tracer", category: "tools" }),
      ctx.actor,
    );
    const tradeTool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Crimper", category: "tools" }),
      ctx.actor,
    );
    const uninventoried = await createProduct(
      ctx.db,
      makeProductInput({ name: "Sold-off bender", category: "tools" }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Van" }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: tradeTool.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    await createExpense(
      ctx.db,
      toolExpense({
        name: "Circuit tracer",
        projectId: target.id,
        productId: boughtHere.id,
        trade: "electrical",
        cost: 160,
      }),
      ctx.actor,
    );
    for (const product of [tradeTool, uninventoried]) {
      await createExpense(
        ctx.db,
        toolExpense({
          name: product.name,
          projectId: history.id,
          productId: product.id,
          trade: "electrical",
          cost: 220,
        }),
        ctx.actor,
      );
    }
    await attachProjectResources(
      ctx.db,
      historyId,
      [tradeTool.entityId],
      ctx.actor,
    );
    await attachProjectResources(
      ctx.db,
      history2Id,
      [tradeTool.entityId],
      ctx.actor,
    );

    const single = await suggestProjectTools(ctx.db, targetId);
    const matrix = await projectToolMatrix(ctx.db, matrixInput());
    const rowIds = new Set(matrix.rows.map((row) => row.productId));

    const expected = single.items
      .filter((item) => rowIds.has(item.productId))
      .map((item) => ({
        productId: item.productId,
        lane: item.lane,
        matchedTrade: item.matchedTrade,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));
    const actual = matrix.cells
      .filter(
        (cell) => cell.state === "suggested" && cell.projectId === target.id,
      )
      .map((cell) => ({
        productId: cell.productId,
        lane: cell.lane,
        matchedTrade: cell.matchedTrade,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    expect(actual).toEqual(expected);
    expect(actual).toEqual(
      expect.arrayContaining([
        {
          productId: boughtHere.id,
          lane: "purchased_here",
          matchedTrade: null,
        },
        {
          productId: tradeTool.id,
          lane: "trade_match",
          matchedTrade: "electrical",
        },
      ]),
    );
    expect(actual.map((cell) => cell.productId)).not.toContain(
      uninventoried.id,
    );

    // Dropping the inferred lane leaves only the exact one.
    const exactOnly = await projectToolMatrix(
      ctx.db,
      matrixInput({ suggestionLanes: ["purchased_here"] }),
    );
    expect(
      exactOnly.cells.filter((cell) => cell.lane === "trade_match"),
    ).toEqual([]);
  });

  it("locks trade matches for tools we did not own, and keeps the grid honest", async () => {
    // The live Kitchen Remodel shape: an explicit end date a year before the
    // tool was bought. `trade_match` used to draw from the whole present-day
    // tool shelf, which on production made 80-99% of an old project's
    // suggestions impossible.
    const { output: finished, entityId: finishedId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Finished reno",
        startDate: "2022-01-01",
        endDate: "2022-06-30",
        status: "done",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Rough-in",
        projectId: finished.id,
        trade: "electrical",
      }),
      ctx.actor,
    );

    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Shelf" }),
      ctx.actor,
    );
    const stock = async (productId: string) =>
      createInventoryEntry(
        ctx.db,
        {
          productId,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

    const boughtLater = await createProduct(
      ctx.db,
      makeProductInput({ name: "Late crimper", category: "tools" }),
      ctx.actor,
    );
    const owned = await createProduct(
      ctx.db,
      makeProductInput({ name: "Owned tester", category: "tools" }),
      ctx.actor,
    );
    const undated = await createProduct(
      ctx.db,
      makeProductInput({ name: "Ledgerless pliers", category: "tools" }),
      ctx.actor,
    );
    await stock(boughtLater.id);
    await stock(owned.id);
    await stock(undated.id);

    // A separate project carries the acquisitions, so `finished`'s own window
    // stays exactly the explicit override.
    const { output: elsewhere } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Other work" }),
      ctx.actor,
    );
    for (const row of [
      { product: boughtLater, date: "2024-03-01" },
      { product: owned, date: "2021-05-01" },
    ]) {
      await createExpense(
        ctx.db,
        toolExpense({
          name: row.product.name,
          projectId: elsewhere.id,
          productId: row.product.id,
          trade: "electrical",
          cost: 250,
          date: row.date,
        }),
        ctx.actor,
      );
    }

    const suggestions = await suggestProjectTools(ctx.db, finishedId);
    const suggested = suggestions.items.map((item) => item.productId);
    expect(suggested).toContain(owned.id);
    expect(suggested).not.toContain(boughtLater.id);
    // Disclosed, not silently dropped — a lane that quietly shrinks reads as
    // "nothing else to suggest".
    expect(suggestions.timelineConflicts).toEqual({ count: 1 });

    // `undated` has no acquisition Expense at all. Unknown must never restrict:
    // 42 of the 426 live tools are in exactly that state.
    expect(suggestions.timelineConflicts.count).toBe(1);

    const matrix = await projectToolMatrix(
      ctx.db,
      matrixInput({ minNetLifetimeCost: 0 }),
    );
    expect(
      matrix.cells.filter(
        (cell) =>
          cell.projectId === finished.id && cell.productId === boughtLater.id,
      ),
    ).toEqual([]);
    expect(
      matrix.rows.find((row) => row.productId === boughtLater.id)?.ownership,
    ).toEqual({ acquiredAt: "2024-03-01", disposedAt: null });
    expect(
      matrix.rows.find((row) => row.productId === undated.id)?.ownership,
    ).toEqual({ acquiredAt: null, disposedAt: null });
    expect(matrix.totals.timelineConflictCells).toBeGreaterThan(0);

    // And the write path refuses it outright, so MCP and a stale client can't
    // create what the grid won't offer.
    await expect(
      setProjectToolUsage(
        ctx.db,
        finishedId,
        boughtLater.entityId,
        true,
        ctx.actor,
      ),
    ).rejects.toMatchObject({ cause: { reason: "TOOL_TIMELINE_CONFLICT" } });
    await expect(
      attachProjectResources(
        ctx.db,
        finishedId,
        [boughtLater.entityId],
        ctx.actor,
      ),
    ).rejects.toMatchObject({ cause: { reason: "TOOL_TIMELINE_CONFLICT" } });
    await expect(
      setProjectToolUsage(ctx.db, finishedId, owned.entityId, true, ctx.actor),
    ).resolves.toEqual({ changed: true });
    await expect(
      setProjectToolUsage(
        ctx.db,
        finishedId,
        undated.entityId,
        true,
        ctx.actor,
      ),
    ).resolves.toEqual({ changed: true });
  });

  it("gives a derived boundary grace an explicit one does not get", async () => {
    // A derived window is only the min/max of dated content, so it routinely
    // stops short of the real last day of work. An explicit date is a
    // statement and is taken literally.
    const makeProject = async (name: string, explicitEnd: string | null) =>
      createProject(
        ctx.db,
        projectCreateInput.parse({
          name,
          status: "done",
          ...(explicitEnd
            ? { startDate: "2022-01-01", endDate: explicitEnd }
            : {}),
        }),
        ctx.actor,
      );

    const { output: derived, entityId: derivedId } = await makeProject(
      "Derived window",
      null,
    );
    const { entityId: explicitId } = await makeProject(
      "Explicit window",
      "2022-06-30",
    );
    for (const projectId of [derived.id]) {
      await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Wire it",
          projectId,
          trade: "electrical",
          dueDate: "2022-06-30",
        }),
        ctx.actor,
      );
    }

    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Slightly late meter", category: "tools" }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Bench" }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: tool.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    const { output: elsewhere } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Acquisition home" }),
      ctx.actor,
    );
    // 20 days past both ends — inside the 30-day grace, which only the derived
    // window is entitled to.
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Meter",
        projectId: elsewhere.id,
        productId: tool.id,
        trade: "electrical",
        cost: 250,
        date: "2022-07-20",
      }),
      ctx.actor,
    );

    await expect(
      setProjectToolUsage(ctx.db, derivedId, tool.entityId, true, ctx.actor),
    ).resolves.toEqual({ changed: true });
    await expect(
      setProjectToolUsage(ctx.db, explicitId, tool.entityId, true, ctx.actor),
    ).rejects.toMatchObject({ cause: { reason: "TOOL_TIMELINE_CONFLICT" } });
  });

  it("reopens the window for a tool sold and later re-bought", async () => {
    const { output: later, entityId: laterId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "After the rebuy",
        startDate: "2024-01-01",
        endDate: "2024-03-01",
        status: "done",
      }),
      ctx.actor,
    );
    const { output: ledger } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Ledger home" }),
      ctx.actor,
    );

    const soldOnly = await createProduct(
      ctx.db,
      makeProductInput({ name: "Gone planer", category: "tools" }),
      ctx.actor,
    );
    const rebought = await createProduct(
      ctx.db,
      makeProductInput({ name: "Replaced planer", category: "tools" }),
      ctx.actor,
    );

    // A disposal is a Purchase whose Expenses NET negative — a bare negative
    // line is a refund and must not close the window. `createExpense` resolves
    // vendor + orderId into that Purchase, same as the detector's own fixtures.
    // One order id per product, so the two disposals stay separate Purchases.
    const disposal = (
      productId: (typeof soldOnly)["id"],
      orderId: string,
      date: string,
    ) =>
      createExpense(
        ctx.db,
        toolExpense({
          name: "Sold",
          productId,
          vendor: "eBay",
          orderId,
          cost: -100,
          date,
        }),
        ctx.actor,
      );

    for (const row of [
      { product: soldOnly, orderId: "TOOL-SALE-1" },
      { product: rebought, orderId: "TOOL-SALE-2" },
    ]) {
      await createExpense(
        ctx.db,
        toolExpense({
          name: "Original buy",
          projectId: ledger.id,
          productId: row.product.id,
          cost: 250,
          date: "2021-01-01",
        }),
        ctx.actor,
      );
      await disposal(row.product.id, row.orderId, "2023-01-01");
    }
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Bought again",
        projectId: ledger.id,
        productId: rebought.id,
        cost: 250,
        date: "2023-06-01",
      }),
      ctx.actor,
    );

    await expect(
      setProjectToolUsage(ctx.db, laterId, soldOnly.entityId, true, ctx.actor),
    ).rejects.toMatchObject({ cause: { reason: "TOOL_TIMELINE_CONFLICT" } });
    await expect(
      setProjectToolUsage(ctx.db, laterId, rebought.entityId, true, ctx.actor),
    ).resolves.toEqual({ changed: true });

    const matrix = await projectToolMatrix(
      ctx.db,
      matrixInput({ minNetLifetimeCost: 0 }),
    );
    expect(
      matrix.rows.find((row) => row.productId === soldOnly.id)?.ownership,
    ).toEqual({ acquiredAt: "2021-01-01", disposedAt: "2023-01-01" });
    expect(
      matrix.rows.find((row) => row.productId === rebought.id)?.ownership,
    ).toEqual({ acquiredAt: "2021-01-01", disposedAt: null });
    expect(later.id).toBeTruthy();
  });

  it("never blocks detaching, or an edge with purchase evidence", async () => {
    const { output: finished, entityId: finishedId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Locked-down reno",
        startDate: "2022-01-01",
        endDate: "2022-06-30",
        status: "done",
      }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Anachronistic saw", category: "tools" }),
      ctx.actor,
    );
    // Bought FOR this project but dated after the explicit end. Ledger evidence
    // beats the inferred window: lane A never checks, and the cell stays live.
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Saw",
        projectId: finished.id,
        productId: tool.id,
        cost: 300,
        date: "2024-01-01",
      }),
      ctx.actor,
    );

    // A sub-floor purchase on the same project — the `purchase_evidence` cell,
    // which is equally clickable and must be equally writable.
    const cheapTool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Anachronistic bit set", category: "tools" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Bits",
        projectId: finished.id,
        productId: cheapTool.id,
        cost: 40,
        date: "2024-01-01",
      }),
      ctx.actor,
    );

    const matrix = await projectToolMatrix(
      ctx.db,
      matrixInput({ minNetLifetimeCost: 0 }),
    );
    expect(
      matrix.cells.find(
        (cell) => cell.projectId === finished.id && cell.productId === tool.id,
      ),
    ).toMatchObject({ state: "suggested", lane: "purchased_here" });
    expect(
      matrix.cells.find(
        (cell) =>
          cell.projectId === finished.id && cell.productId === cheapTool.id,
      ),
    ).toMatchObject({ state: "purchase_evidence", projectPurchaseCost: 40 });

    // The write path must honour the SAME exemption the cells above advertise,
    // or the grid offers a confirm action that always errors and reverts.
    await expect(
      setProjectToolUsage(ctx.db, finishedId, tool.entityId, true, ctx.actor),
    ).resolves.toEqual({ changed: true });
    await expect(
      setProjectToolUsage(
        ctx.db,
        finishedId,
        cheapTool.entityId,
        true,
        ctx.actor,
      ),
    ).resolves.toEqual({ changed: true });
    // ...through every attach path, not just the single setter.
    await detachProjectResources(
      ctx.db,
      finishedId,
      [tool.entityId, cheapTool.entityId],
      ctx.actor,
    );
    await expect(
      attachProjectResources(
        ctx.db,
        finishedId,
        [tool.entityId, cheapTool.entityId],
        ctx.actor,
      ),
    ).resolves.toMatchObject({ changed: 2 });
    await expect(
      setProductProjectUses(ctx.db, tool.entityId, [finishedId], ctx.actor),
    ).resolves.toEqual({ changed: 0 });

    // An already-recorded conflicting edge must stay removable, and re-saving a
    // set that contains it must not throw — otherwise the rows this rule exists
    // to surface would be permanently stuck.
    const stuck = await createProduct(
      ctx.db,
      makeProductInput({ name: "Stuck driver", category: "tools" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .insert(projectToolUsage)
      .values({ projectId: finishedId, productId: stuck.entityId });
    const { output: elsewhere } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Driver ledger" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      toolExpense({
        name: "Driver",
        projectId: elsewhere.id,
        productId: stuck.id,
        cost: 250,
        date: "2025-01-01",
      }),
      ctx.actor,
    );

    await expect(
      setProductProjectUses(ctx.db, stuck.entityId, [finishedId], ctx.actor),
    ).resolves.toEqual({ changed: 0 });
    await expect(
      setProjectToolUsage(ctx.db, finishedId, stuck.entityId, false, ctx.actor),
    ).resolves.toEqual({ changed: true });
    // And once removed it can no longer be re-created.
    await expect(
      setProjectToolUsage(ctx.db, finishedId, stuck.entityId, true, ctx.actor),
    ).rejects.toMatchObject({ cause: { reason: "TOOL_TIMELINE_CONFLICT" } });
  });

  it("counts visible and lifetime uses separately", async () => {
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Well-travelled drill", category: "tools" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      toolExpense({ name: "Drill", productId: tool.id, cost: 400 }),
      ctx.actor,
    );
    const ids = [];
    for (const spec of [
      { name: "In scope A", kind: "renovation" as const },
      { name: "In scope B", kind: "renovation" as const },
      { name: "Out of scope", kind: "garden" as const },
    ]) {
      const { output, entityId } = await createProject(
        ctx.db,
        projectCreateInput.parse({ name: spec.name, kind: spec.kind }),
        ctx.actor,
      );
      ids.push({ output, entityId });
      await setProjectToolUsage(
        ctx.db,
        entityId,
        tool.entityId,
        true,
        ctx.actor,
      );
    }

    const scoped = await projectToolMatrix(
      ctx.db,
      matrixInput({ kinds: ["renovation"] }),
    );
    expect(scoped.rows[0]).toMatchObject({
      visibleUseCount: 2,
      projectUseCount: 3,
      costPerProjectUse: 400 / 3,
    });
  });

  it("sets one usage pair idempotently", async () => {
    const { entityId: projectId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Toggle target" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Toggle tool", category: "tools" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      toolExpense({ name: "Toggle tool", productId: tool.id, cost: 250 }),
      ctx.actor,
    );

    await expect(
      setProjectToolUsage(ctx.db, projectId, tool.entityId, true, ctx.actor),
    ).resolves.toEqual({ changed: true });
    await expect(
      setProjectToolUsage(ctx.db, projectId, tool.entityId, true, ctx.actor),
    ).resolves.toEqual({ changed: false });
    // The economics the toggle moves are asserted through the grid, which is
    // what actually renders them — the setter itself returns no metrics.
    await expect(listProjectResources(ctx.db, projectId)).resolves.toEqual([
      expect.objectContaining({
        projectUseCount: 1,
        netLifetimeCost: 250,
        costPerProjectUse: 250,
      }),
    ]);
    await expect(
      setProjectToolUsage(ctx.db, projectId, tool.entityId, false, ctx.actor),
    ).resolves.toEqual({ changed: true });
    await expect(
      setProjectToolUsage(ctx.db, projectId, tool.entityId, false, ctx.actor),
    ).resolves.toEqual({ changed: false });
    // Re-attaching after a soft delete inserts a fresh row, not a conflict.
    await expect(
      setProjectToolUsage(ctx.db, projectId, tool.entityId, true, ctx.actor),
    ).resolves.toEqual({ changed: true });
    await expect(listProjectResources(ctx.db, projectId)).resolves.toHaveLength(
      1,
    );
  });

  it("writes one pair-scoped audit entry and none for a no-op", async () => {
    const { entityId: projectId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Audited toggle" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Audited tool", category: "tools" }),
      ctx.actor,
    );

    await setProjectToolUsage(
      ctx.db,
      projectId,
      tool.entityId,
      true,
      ctx.actor,
    );
    await setProjectToolUsage(
      ctx.db,
      projectId,
      tool.entityId,
      true,
      ctx.actor,
    );

    const entries = await getDb(ctx.db)
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, projectId), eq(auditLog.action, "update")),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changes?.usedResource).toEqual({
      from: null,
      to: tool.id,
    });

    await setProjectToolUsage(
      ctx.db,
      projectId,
      tool.entityId,
      false,
      ctx.actor,
    );
    const afterDetach = await getDb(ctx.db)
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, projectId), eq(auditLog.action, "update")),
      );
    expect(afterDetach).toHaveLength(2);
    expect(
      afterDetach.some(
        (entry) =>
          entry.changes?.usedResource?.from === tool.id &&
          entry.changes?.usedResource?.to === null,
      ),
    ).toBe(true);
  });

  it("replaces a tool's project set without disturbing the projects that stay", async () => {
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Reassigned tool", category: "tools" }),
      ctx.actor,
    );
    const made = [];
    for (const name of ["Keep me", "Drop me", "Add me"]) {
      const { output, entityId } = await createProject(
        ctx.db,
        projectCreateInput.parse({ name }),
        ctx.actor,
      );
      made.push({ output, entityId });
    }
    const [keep, drop, add] = made;
    if (!keep || !drop || !add) throw new Error("fixture setup failed");

    await attachProjectResources(
      ctx.db,
      keep.entityId,
      [tool.entityId],
      ctx.actor,
    );
    await attachProjectResources(
      ctx.db,
      drop.entityId,
      [tool.entityId],
      ctx.actor,
    );
    const [keepRowBefore] = await getDb(ctx.db)
      .select()
      .from(projectToolUsage)
      .where(
        and(
          eq(projectToolUsage.projectId, keep.entityId),
          eq(projectToolUsage.productId, tool.entityId),
          notDeleted(projectToolUsage),
        ),
      );

    await expect(
      setProductProjectUses(
        ctx.db,
        tool.entityId,
        [keep.entityId, add.entityId],
        ctx.actor,
      ),
    ).resolves.toEqual({ changed: 2 });

    const uses = await listProductProjectUses(ctx.db, tool.entityId);
    expect(uses.projects.map((row) => row.projectId).sort()).toEqual(
      [keep.output.id, add.output.id].sort(),
    );

    const [keepRowAfter] = await getDb(ctx.db)
      .select()
      .from(projectToolUsage)
      .where(
        and(
          eq(projectToolUsage.projectId, keep.entityId),
          eq(projectToolUsage.productId, tool.entityId),
          notDeleted(projectToolUsage),
        ),
      );
    expect(keepRowAfter?.id).toBe(keepRowBefore?.id);
    expect(keepRowAfter?.createdAt).toEqual(keepRowBefore?.createdAt);

    const [entry] = await getDb(ctx.db)
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, tool.entityId),
          eq(auditLog.action, "update"),
        ),
      );
    expect(entry?.changes?.usedOnProjectIds).toEqual({
      from: [drop.output.id, keep.output.id].sort(),
      to: [add.output.id, keep.output.id].sort(),
    });

    // Clearing the set is a legal replacement, not a rejected empty input.
    await expect(
      setProductProjectUses(ctx.db, tool.entityId, [], ctx.actor),
    ).resolves.toEqual({ changed: 2 });
    await expect(
      listProductProjectUses(ctx.db, tool.entityId),
    ).resolves.toMatchObject({ projects: [] });
  });

  it("rejects a non-tool product and a dead project in both directions", async () => {
    const { output: doomed, entityId: projectId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Doomed project" }),
      ctx.actor,
    );
    const pantryItem = await createProduct(
      ctx.db,
      makeProductInput({ name: "Olive oil", category: "food" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Live tool", category: "tools" }),
      ctx.actor,
    );

    await expect(
      setProjectToolUsage(
        ctx.db,
        projectId,
        pantryItem.entityId,
        true,
        ctx.actor,
      ),
    ).rejects.toThrow();
    await expect(
      setProductProjectUses(
        ctx.db,
        pantryItem.entityId,
        [projectId],
        ctx.actor,
      ),
    ).rejects.toThrow();

    await deleteProjects(ctx.db, [doomed.id], ctx.actor);
    // Both directions must throw: a silent `used: false` success against a dead
    // project would clear a checkbox that never cleared anything.
    await expect(
      setProjectToolUsage(ctx.db, projectId, tool.entityId, true, ctx.actor),
    ).rejects.toThrow();
    await expect(
      setProjectToolUsage(ctx.db, projectId, tool.entityId, false, ctx.actor),
    ).rejects.toThrow();
    await expect(
      setProductProjectUses(ctx.db, tool.entityId, [projectId], ctx.actor),
    ).rejects.toThrow();
  });

  it("filters rows by tool search across both name and manufacturer", async () => {
    for (const spec of [
      { name: "Blue drill", manufacturer: "Makita" },
      { name: "Red saw", manufacturer: "Milwaukee" },
      { name: "Green sander", manufacturer: "Makita" },
    ]) {
      const made = await createProduct(
        ctx.db,
        makeProductInput({
          name: spec.name,
          manufacturer: spec.manufacturer,
          category: "tools",
        }),
        ctx.actor,
      );
      await createExpense(
        ctx.db,
        toolExpense({ name: spec.name, productId: made.id, cost: 200 }),
        ctx.actor,
      );
    }

    const byName = await projectToolMatrix(
      ctx.db,
      matrixInput({ toolSearch: "drill" }),
    );
    expect(byName.rows.map((row) => row.productName)).toEqual(["Blue drill"]);
    expect(byName.totals.matchingTools).toBe(1);

    // The OR arm: a term that matches no name still finds every tool by that
    // maker. `buildSearchConditions` ANDs its search filters, so these two
    // predicates have to be combined by hand — a regression here would silently
    // return nothing rather than error.
    const byManufacturer = await projectToolMatrix(
      ctx.db,
      matrixInput({ toolSearch: "makita" }),
    );
    expect(byManufacturer.rows.map((row) => row.productName).sort()).toEqual([
      "Blue drill",
      "Green sander",
    ]);

    // Whitespace-only is not a filter.
    const blank = await projectToolMatrix(
      ctx.db,
      matrixInput({ toolSearch: "   " }),
    );
    expect(blank.totals.matchingTools).toBe(3);
  });

  it("scopes columns by completion year", async () => {
    for (const spec of [
      { name: "Finished in 2024", date: "2024-05-10" },
      { name: "Finished in 2026", date: "2026-05-10" },
    ]) {
      const { output } = await createProject(
        ctx.db,
        projectCreateInput.parse({ name: spec.name }),
        ctx.actor,
      );
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: `${spec.name} spend`,
          projectId: output.id,
          cost: 40,
          date: spec.date,
        }),
        ctx.actor,
      );
    }

    // The only filter that needs the project tree folded before the column
    // WHERE can be built, so it takes a different code path to every other one.
    const scoped = await projectToolMatrix(
      ctx.db,
      matrixInput({ completionYear: "2024" }),
    );
    expect(scoped.columns.map((column) => column.projectName)).toEqual([
      "Finished in 2024",
    ]);
    expect(scoped.totals.matchingProjects).toBe(1);
  });

  it("groups rows by manufacturer when asked", async () => {
    for (const spec of [
      { name: "Blue drill", manufacturer: "Makita" },
      { name: "Red saw", manufacturer: "Milwaukee" },
      { name: "Nameless jig", manufacturer: "" },
    ]) {
      const made = await createProduct(
        ctx.db,
        makeProductInput({
          name: spec.name,
          manufacturer: spec.manufacturer,
          category: "tools",
        }),
        ctx.actor,
      );
      await createExpense(
        ctx.db,
        toolExpense({ name: spec.name, productId: made.id, cost: 200 }),
        ctx.actor,
      );
    }

    const byMaker = await projectToolMatrix(
      ctx.db,
      matrixInput({ groupBy: "manufacturer" }),
    );
    expect(byMaker.groups).toEqual([
      { key: "Makita", label: "Makita", rowCount: 1 },
      { key: "Milwaukee", label: "Milwaukee", rowCount: 1 },
      { key: "", label: "Unknown manufacturer", rowCount: 1 },
    ]);
    expect(byMaker.rows.map((row) => row.groupKey)).toEqual([
      "Makita",
      "Milwaukee",
      "",
    ]);
  });
});

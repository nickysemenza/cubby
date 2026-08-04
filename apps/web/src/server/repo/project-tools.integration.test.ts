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
    expect(capped.totals.matchingProjects).toBe(3);
    expect(capped.truncated.columns).toBe(true);
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
    expect(before.cells).toEqual([
      {
        projectId: rich.id,
        productId: tool.id,
        state: "suggested",
        lane: "purchased_here",
        matchedTrade: null,
        projectPurchaseCost: 300,
      },
    ]);
    expect(before.totals.suggestedCells).toBe(1);

    // Below the suggestion floor a pair earns no cell of its own, but once it
    // IS attached the same query still reports what was bought there.
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

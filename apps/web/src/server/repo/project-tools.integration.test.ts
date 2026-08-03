import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense, deleteExpenses } from "./expense";
import { deleteProducts, updateProduct } from "./product";
import { createProject, deleteProjects, getProjectByID } from "./project";
import {
  attachProjectResources,
  detachProjectResources,
  listProductProjectUses,
  listProjectResources,
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

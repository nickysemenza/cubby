import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense } from "./expense";
import { deleteProducts } from "./product";
import { createProject, deleteProjects } from "./project";
import {
  attachProjectTools,
  detachProjectTools,
  listProductProjectUses,
  listProjectTools,
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

describe("project tool usage", () => {
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
      attachProjectTools(ctx.db, kitchenId, [tool.entityId], ctx.actor),
    ).resolves.toEqual({ changed: 1, attached: 1 });
    await expect(
      attachProjectTools(ctx.db, kitchenId, [tool.entityId], ctx.actor),
    ).resolves.toEqual({ changed: 0, attached: 1 });
    await attachProjectTools(ctx.db, yardId, [tool.entityId], ctx.actor);

    await expect(listProjectTools(ctx.db, kitchenId)).resolves.toEqual([
      expect.objectContaining({
        productId: tool.id,
        projectPurchaseCost: 300,
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
      detachProjectTools(ctx.db, yardId, [tool.entityId], ctx.actor),
    ).resolves.toEqual({ changed: 1, attached: 0 });
    await expect(listProjectTools(ctx.db, kitchenId)).resolves.toEqual([
      expect.objectContaining({
        projectUseCount: 1,
        netLifetimeCost: 250,
        costPerProjectUse: 250,
      }),
    ]);
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
    await attachProjectTools(
      ctx.db,
      historyAId,
      [reusedTradeTool.entityId, oneUseCheapTool.entityId],
      ctx.actor,
    );
    await attachProjectTools(
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
    await attachProjectTools(ctx.db, projectId, [tool.entityId], ctx.actor);

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

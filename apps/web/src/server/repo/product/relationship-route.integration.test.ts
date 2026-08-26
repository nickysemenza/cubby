import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { expense, location } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createExpense } from "~/server/repo/expense";
import { createProject } from "~/server/repo/project";
import { attachProjectResources } from "~/server/repo/project/tools";
import { attachPurchaseProducts } from "~/server/repo/purchase-products";
import {
  createInventoryFixture as createInventory,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { createTask } from "~/server/repo/task";
import { getProductRelationshipRoute } from "./relationship-route";

describe("getProductRelationshipRoute", () => {
  const ctx = withTestDb();

  it("keeps direct and derived Product relationships distinct and bounds every preview", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Route drill", category: "tools" }),
      ctx.actor,
    );
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Route project" }),
      ctx.actor,
    );
    const stockLocation = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Route shelf" }),
      ctx.actor,
    );
    const identityLocation = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Route case", productId: product.id }),
      ctx.actor,
    );
    await createInventory(
      ctx.db,
      {
        productId: product.id,
        locationId: stockLocation.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    await createInventory(
      ctx.db,
      {
        productId: product.id,
        locationId: identityLocation.id,
        amount: { value: 1, unit: "each" },
        placement: "installed",
      },
      ctx.actor,
    );

    for (const index of [1, 2, 3, 4]) {
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: `Route acquisition ${index}`,
          cost: index,
          date: `2026-03-0${index}`,
          productId: product.id,
          productQuantity: 1,
          projectId: project.output.id,
          vendor: "Route vendor",
          orderId: `ROUTE-${index}`,
        }),
        ctx.actor,
      );
    }
    const linkedExpense = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Route explicit purchase",
        cost: 9,
        date: "2026-03-05",
        productId: product.id,
        productQuantity: 1,
        vendor: "Route vendor",
        orderId: "ROUTE-BOTH",
      }),
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      await resolveOrThrow(
        ctx.db,
        "purchase",
        linkedExpense.output.purchaseId!,
      ),
      [product.entityId],
      ctx.actor,
    );
    await attachProjectResources(
      ctx.db,
      project.entityId,
      [product.entityId],
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Route task",
        trade: "other",
        projectId: project.output.id,
        subjectProductId: product.id,
      }),
      ctx.actor,
    );

    const route = await getProductRelationshipRoute(ctx.db, product.entityId);

    expect(route.productId).toBe(product.id);
    expect(route.inventory).toMatchObject({
      count: 2,
      stockCount: 1,
      installedCount: 1,
    });
    expect(route.identityLocations).toMatchObject({ count: 1 });
    expect(route.expenses).toMatchObject({ count: 5, netCost: 19 });
    expect(route.expenses.preview).toHaveLength(3);
    expect(route.purchases).toMatchObject({ count: 5 });
    expect(route.purchases.preview).toHaveLength(3);
    expect(
      route.purchases.preview.find((row) => row.orderId === "ROUTE-BOTH")
        ?.source,
    ).toBe("both");
    expect(route.usedOnProjects).toMatchObject({ count: 1 });
    expect(route.purchasedForProjects).toMatchObject({ count: 1 });
    expect(route.tasks).toMatchObject({ count: 1, openCount: 1 });
    expect(route.vendors).toMatchObject({ count: 1 });
    expect(route).toEqual(
      expect.objectContaining({
        inventory: expect.objectContaining({
          preview: expect.arrayContaining([
            expect.objectContaining({ id: expect.stringMatching(/^INV-/) }),
          ]),
        }),
        purchases: expect.objectContaining({
          preview: expect.arrayContaining([
            expect.objectContaining({ id: expect.stringMatching(/^PUR-/) }),
          ]),
        }),
      }),
    );
  });

  it("does not route through soft-deleted relationship records or targets", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Retired route product" }),
      ctx.actor,
    );
    const stockLocation = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Retired route shelf" }),
      ctx.actor,
    );
    const identityLocation = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Retired route case",
        productId: product.id,
      }),
      ctx.actor,
    );
    await createInventory(
      ctx.db,
      {
        productId: product.id,
        locationId: stockLocation.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    const productExpense = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Retired route acquisition",
        cost: 12,
        productId: product.id,
        productQuantity: 1,
        vendor: "Retired route vendor",
        orderId: "RETIRED-1",
      }),
      ctx.actor,
    );

    const deletedAt = new Date();
    await getDb(ctx.db)
      .update(expense)
      .set({ deletedAt })
      .where(eq(expense.id, productExpense.entityId));
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt })
      .where(eq(location.id, stockLocation.entityId));
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt })
      .where(eq(location.id, identityLocation.entityId));

    const route = await getProductRelationshipRoute(ctx.db, product.entityId);
    expect(route.inventory.count).toBe(0);
    expect(route.identityLocations.count).toBe(0);
    expect(route.expenses.count).toBe(0);
    expect(route.purchases.count).toBe(0);
    expect(route.vendors.count).toBe(0);
  });
});

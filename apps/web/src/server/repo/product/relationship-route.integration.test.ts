import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { expense, location, project as projectTable } from "~/server/db/schema";
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
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createTask } from "~/server/repo/task";
import { findOrCreateVendor } from "~/server/repo/vendor";
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
    const linkOnlyPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: await findOrCreateVendor(ctx.db, "Link-only vendor"),
      date: "2026-03-08",
      displayLabel: "Route link-only purchase",
    });
    await attachPurchaseProducts(
      ctx.db,
      linkOnlyPurchase.id,
      [product.entityId],
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Route explicit purchase second line",
        cost: 1,
        date: "2026-03-05",
        productId: product.id,
        productQuantity: 1,
        purchaseId: linkedExpense.output.purchaseId,
      }),
      ctx.actor,
    );
    const expenseOnlyPurchase = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Route expense-only first line",
        cost: 2,
        date: "2026-03-09",
        productId: product.id,
        productQuantity: 1,
        vendor: "Expense-only vendor",
        orderId: "ROUTE-EXPENSE",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Route expense-only second line",
        cost: 3,
        date: "2026-03-09",
        productId: product.id,
        productQuantity: 1,
        purchaseId: expenseOnlyPurchase.output.purchaseId,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Route expense-only third line",
        cost: 4,
        date: "2026-03-09",
        productId: product.id,
        productQuantity: 1,
        purchaseId: expenseOnlyPurchase.output.purchaseId,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Route planned spend",
        cost: 50,
        date: "2026-03-06",
        future: true,
        productId: product.id,
        productQuantity: 1,
        projectId: project.output.id,
        vendor: "Future-only vendor",
        orderId: "ROUTE-FUTURE",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Route exit",
        cost: -10,
        date: "2026-03-07",
        productId: product.id,
        productQuantity: -1,
        projectId: project.output.id,
        vendor: "Exit-only vendor",
        orderId: "ROUTE-EXIT",
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
    expect(route.direct.inventory).toMatchObject({
      count: 2,
      stockCount: 1,
      installedCount: 1,
    });
    expect(route.direct.identityLocations).toMatchObject({ count: 1 });
    expect(route.direct.expenses).toMatchObject({ count: 11, netCost: 69 });
    expect(route.direct.expenses.preview).toHaveLength(3);
    expect(route.direct.purchases).toMatchObject({ count: 7 });
    expect(route.direct.purchases.preview).toHaveLength(3);
    expect(
      route.direct.purchases.preview.find((row) => row.orderId === "ROUTE-BOTH")
        ?.source,
    ).toBe("both");
    expect(
      route.direct.purchases.preview.find(
        (row) => row.displayLabel === "Route link-only purchase",
      )?.source,
    ).toBe("link");
    expect(
      route.direct.purchases.preview.find(
        (row) => row.orderId === "ROUTE-EXPENSE",
      )?.source,
    ).toBe("expense");
    expect(route.direct.usedOnProjects).toMatchObject({ count: 1 });
    expect(route.derived.purchasedForProjects).toMatchObject({
      count: 1,
      unassignedExpenseCount: 5,
    });
    expect(route.direct.tasks).toMatchObject({ count: 1, openCount: 1 });
    expect(route.derived.vendors).toMatchObject({ count: 2 });
    expect(route.derived.vendors.preview.map((vendor) => vendor.name)).toEqual(
      expect.arrayContaining(["Route vendor", "Expense-only vendor"]),
    );
    expect(
      route.derived.vendors.preview.map((vendor) => vendor.name),
    ).not.toContain("Future-only vendor");
    expect(
      route.derived.vendors.preview.map((vendor) => vendor.name),
    ).not.toContain("Exit-only vendor");
    expect(route).toEqual(
      expect.objectContaining({
        direct: expect.objectContaining({
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
    const retiredProject = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Retired route project" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Retired route project acquisition",
        cost: 8,
        productId: product.id,
        productQuantity: 1,
        projectId: retiredProject.output.id,
        vendor: "Retired route project vendor",
        orderId: "RETIRED-PROJECT",
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
    await getDb(ctx.db)
      .update(projectTable)
      .set({ deletedAt })
      .where(eq(projectTable.id, retiredProject.entityId));

    const route = await getProductRelationshipRoute(ctx.db, product.entityId);
    expect(route.direct.inventory.count).toBe(0);
    expect(route.direct.identityLocations.count).toBe(0);
    expect(route.direct.expenses).toMatchObject({ count: 1 });
    expect(route.direct.expenses.preview[0]?.project).toBeNull();
    expect(route.direct.purchases.count).toBe(1);
    expect(route.derived.vendors.count).toBe(1);
    expect(route.derived.purchasedForProjects).toMatchObject({
      count: 0,
      unassignedExpenseCount: 0,
    });
  });
});

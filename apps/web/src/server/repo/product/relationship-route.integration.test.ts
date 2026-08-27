import { productRelationshipRouteOut } from "@cubby/schemas/product";
import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  expense,
  location,
  product as productTable,
  project as projectTable,
  projectToolUsage,
  purchase,
  purchaseProduct,
  task,
} from "~/server/db/schema";
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

  it("returns a schema-valid empty route with zeroed counts", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Empty relationship route" }),
      ctx.actor,
    );

    const route = await getProductRelationshipRoute(ctx.db, product.entityId);

    expect(productRelationshipRouteOut.parse(route)).toEqual(route);
    expect(route).toEqual({
      productId: product.id,
      direct: {
        inventory: {
          count: 0,
          stockCount: 0,
          installedCount: 0,
          preview: [],
        },
        identityLocations: { count: 0, preview: [] },
        expenses: { count: 0, netCost: 0, preview: [] },
        purchases: { count: 0, preview: [] },
        usedOnProjects: { count: 0, preview: [] },
        tasks: { count: 0, openCount: 0, preview: [] },
      },
      derived: {
        purchasedForProjects: {
          count: 0,
          unassignedExpenseCount: 0,
          preview: [],
        },
        vendors: { count: 0, preview: [] },
      },
    });
  });

  it("returns PRODUCT_NOT_FOUND for missing and soft-deleted Products", async () => {
    const missingProductId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000099",
    );
    await expect(
      getProductRelationshipRoute(ctx.db, missingProductId),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PRODUCT_NOT_FOUND" },
    });

    const deletedProduct = await createProduct(
      ctx.db,
      makeProductInput({ name: "Deleted relationship route" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(productTable)
      .set({ deletedAt: new Date() })
      .where(eq(productTable.id, deletedProduct.entityId));

    await expect(
      getProductRelationshipRoute(ctx.db, deletedProduct.entityId),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PRODUCT_NOT_FOUND" },
    });
  });

  it("excludes isolated future and negative expenses from derived acquisition branches", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Invalid acquisition route" }),
      ctx.actor,
    );
    const futureProject = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Future-only route project" }),
      ctx.actor,
    );
    const negativeProject = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Negative-only route project" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Future project acquisition",
        cost: 10,
        future: true,
        productId: product.id,
        productQuantity: 1,
        projectId: futureProject.output.id,
        vendor: "Future project vendor",
        orderId: "INVALID-FUTURE-PROJECT",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Negative project acquisition",
        cost: -10,
        productId: product.id,
        productQuantity: -1,
        projectId: negativeProject.output.id,
        vendor: "Negative project vendor",
        orderId: "INVALID-NEGATIVE-PROJECT",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Future unassigned acquisition",
        cost: 5,
        future: true,
        productId: product.id,
        productQuantity: 1,
        vendor: "Future unassigned vendor",
        orderId: "INVALID-FUTURE-UNASSIGNED",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Negative unassigned acquisition",
        cost: -5,
        productId: product.id,
        productQuantity: -1,
        vendor: "Negative unassigned vendor",
        orderId: "INVALID-NEGATIVE-UNASSIGNED",
      }),
      ctx.actor,
    );

    const route = await getProductRelationshipRoute(ctx.db, product.entityId);

    expect(route.direct.expenses.count).toBe(4);
    expect(route.direct.purchases).toEqual({ count: 0, preview: [] });
    expect(route.derived.purchasedForProjects).toEqual({
      count: 0,
      unassignedExpenseCount: 0,
      preview: [],
    });
    expect(route.derived.vendors).toEqual({ count: 0, preview: [] });
  });

  it("caps each purchase source before folding and preserves source-first ties", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Purchase source cap route" }),
      ctx.actor,
    );
    const vendorId = await findOrCreateVendor(ctx.db, "Source cap vendor");
    const linkCodes = ["PUR-WWWW", "PUR-XXXX", "PUR-YYYY", "PUR-ZZZZ"];
    const expectedLinkAttachedAt = new Date("2026-04-01T12:34:56.789Z");
    for (const code of linkCodes) {
      const linkedPurchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId,
        date: "2026-04-01",
        displayLabel: code,
      });
      await getDb(ctx.db)
        .update(purchase)
        .set({ shortcode: testShortcode("purchase", code) })
        .where(eq(purchase.id, linkedPurchase.id));
      await attachPurchaseProducts(
        ctx.db,
        linkedPurchase.id,
        [product.entityId],
        ctx.actor,
      );
      if (code === "PUR-WWWW") {
        await getDb(ctx.db)
          .update(purchaseProduct)
          .set({ createdAt: expectedLinkAttachedAt })
          .where(eq(purchaseProduct.purchaseId, linkedPurchase.id));
      }
    }
    const expenseOnly = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Same-day expense source",
        cost: 1,
        date: "2026-04-01",
        productId: product.id,
        productQuantity: 1,
        vendor: "Source cap vendor",
        orderId: "SOURCE-CAP-EXPENSE",
      }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(purchase)
      .set({ shortcode: testShortcode("purchase", "PUR-2222") })
      .where(
        eq(
          purchase.id,
          await resolveOrThrow(
            ctx.db,
            "purchase",
            expenseOnly.output.purchaseId!,
          ),
        ),
      );

    const route = await getProductRelationshipRoute(ctx.db, product.entityId);

    expect(route.direct.purchases.count).toBe(5);
    expect(
      route.direct.purchases.preview.map((row) => [row.id, row.source]),
    ).toEqual([
      [testShortcode("purchase", "PUR-WWWW"), "link"],
      [testShortcode("purchase", "PUR-XXXX"), "link"],
      [testShortcode("purchase", "PUR-YYYY"), "link"],
    ]);
    expect(route.direct.purchases.preview[0]?.linkAttachedAt).toEqual(
      expectedLinkAttachedAt,
    );
    expect(productRelationshipRouteOut.parse(route)).toEqual(route);
  });

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
    for (const name of [
      "Alpha route shelf",
      "Beta route shelf",
      "Gamma route shelf",
    ]) {
      const extraStockLocation = await createLocation(
        ctx.db,
        makeLocationInput({ name }),
        ctx.actor,
      );
      await createInventory(
        ctx.db,
        {
          productId: product.id,
          locationId: extraStockLocation.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    }
    for (const name of [
      "Alpha identity location",
      "Beta identity location",
      "Gamma identity location",
    ]) {
      await createLocation(
        ctx.db,
        makeLocationInput({ name, productId: product.id }),
        ctx.actor,
      );
    }

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
    for (const name of [
      "Alpha route project",
      "Beta route project",
      "Gamma route project",
    ]) {
      const extraProject = await createProject(
        ctx.db,
        projectCreateInput.parse({ name }),
        ctx.actor,
      );
      await attachProjectResources(
        ctx.db,
        extraProject.entityId,
        [product.entityId],
        ctx.actor,
      );
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: `${name} acquisition`,
          cost: 0,
          date: "2026-03-05",
          productId: product.id,
          productQuantity: 1,
          projectId: extraProject.output.id,
          purchaseId: linkedExpense.output.purchaseId,
        }),
        ctx.actor,
      );
      await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: `${name} task`,
          trade: "other",
          projectId: extraProject.output.id,
          subjectProductId: product.id,
        }),
        ctx.actor,
      );
    }
    for (const [index, vendorName] of [
      "Alpha vendor",
      "Bravo vendor",
    ].entries()) {
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: `${vendorName} acquisition`,
          cost: 0,
          date: `2026-02-0${index + 1}`,
          productId: product.id,
          productQuantity: 1,
          vendor: vendorName,
          orderId: `ROUTE-VENDOR-${index + 1}`,
        }),
        ctx.actor,
      );
    }

    const route = await getProductRelationshipRoute(ctx.db, product.entityId);

    expect(route.productId).toBe(product.id);
    expect(route.direct.inventory).toMatchObject({
      count: 5,
      stockCount: 4,
      installedCount: 1,
    });
    expect(route.direct.inventory.preview).toHaveLength(3);
    expect(
      route.direct.inventory.preview.map((row) => row.location.name),
    ).toEqual(["Alpha route shelf", "Beta route shelf", "Gamma route shelf"]);
    expect(route.direct.identityLocations).toMatchObject({ count: 4 });
    expect(route.direct.identityLocations.preview).toHaveLength(3);
    expect(
      route.direct.identityLocations.preview.map((row) => row.name),
    ).toEqual([
      "Alpha identity location",
      "Beta identity location",
      "Gamma identity location",
    ]);
    expect(route.direct.expenses).toMatchObject({ count: 16, netCost: 69 });
    expect(route.direct.expenses.preview).toHaveLength(3);
    expect(route.direct.purchases).toMatchObject({ count: 9 });
    expect(route.direct.purchases.preview).toHaveLength(3);
    expect(
      route.direct.purchases.preview.map((row) => [row.orderId, row.source]),
    ).toEqual([
      ["ROUTE-EXPENSE", "expense"],
      [null, "link"],
      ["ROUTE-BOTH", "both"],
    ]);
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
    expect(route.direct.usedOnProjects).toMatchObject({ count: 4 });
    expect(route.direct.usedOnProjects.preview).toHaveLength(3);
    expect(route.derived.purchasedForProjects).toMatchObject({
      count: 4,
      unassignedExpenseCount: 7,
    });
    expect(route.derived.purchasedForProjects.preview).toHaveLength(3);
    expect(
      route.derived.purchasedForProjects.preview.map((row) => row.name),
    ).toEqual([
      "Alpha route project",
      "Beta route project",
      "Gamma route project",
    ]);
    expect(route.direct.tasks).toMatchObject({ count: 4, openCount: 4 });
    expect(route.direct.tasks.preview).toHaveLength(3);
    expect(route.direct.tasks.preview.map((row) => row.name)).toEqual([
      "Alpha route project task",
      "Beta route project task",
      "Gamma route project task",
    ]);
    expect(route.derived.vendors).toMatchObject({ count: 4 });
    expect(route.derived.vendors.preview).toHaveLength(3);
    expect(route.derived.vendors.preview.map((vendor) => vendor.name)).toEqual([
      "Alpha vendor",
      "Bravo vendor",
      "Expense-only vendor",
    ]);
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
    expect(productRelationshipRouteOut.parse(route)).toEqual(route);
  });

  it("does not route through soft-deleted relationship records or targets", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Retired route product", category: "tools" }),
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
    const retiredProjectExpense = await createExpense(
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
    const retiredLinkPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: await findOrCreateVendor(ctx.db, "Retired link vendor"),
      date: "2026-01-01",
      displayLabel: "Retired link purchase",
    });
    await attachPurchaseProducts(
      ctx.db,
      retiredLinkPurchase.id,
      [product.entityId],
      ctx.actor,
    );
    await attachProjectResources(
      ctx.db,
      retiredProject.entityId,
      [product.entityId],
      ctx.actor,
    );
    const retiredTask = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Retired route task",
        trade: "other",
        projectId: retiredProject.output.id,
        subjectProductId: product.id,
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
    await getDb(ctx.db)
      .update(purchaseProduct)
      .set({ deletedAt })
      .where(eq(purchaseProduct.purchaseId, retiredLinkPurchase.id));
    await getDb(ctx.db)
      .update(projectToolUsage)
      .set({ deletedAt })
      .where(eq(projectToolUsage.projectId, retiredProject.entityId));
    await getDb(ctx.db)
      .update(task)
      .set({ deletedAt })
      .where(eq(task.id, retiredTask.entityId));
    await getDb(ctx.db)
      .update(purchase)
      .set({ deletedAt })
      .where(
        eq(
          purchase.id,
          await resolveOrThrow(
            ctx.db,
            "purchase",
            retiredProjectExpense.output.purchaseId!,
          ),
        ),
      );

    const route = await getProductRelationshipRoute(ctx.db, product.entityId);
    expect(route.direct.inventory.count).toBe(0);
    expect(route.direct.identityLocations.count).toBe(0);
    expect(route.direct.expenses).toMatchObject({ count: 1 });
    expect(route.direct.expenses.preview[0]?.project).toBeNull();
    expect(route.direct.purchases.count).toBe(0);
    expect(route.direct.usedOnProjects.count).toBe(0);
    expect(route.direct.tasks.count).toBe(0);
    expect(route.derived.vendors.count).toBe(0);
    expect(route.derived.purchasedForProjects).toMatchObject({
      count: 0,
      unassignedExpenseCount: 0,
    });
  });
});

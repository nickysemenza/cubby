import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { updateThroughKernel } from "~/server/testing/entity-kernel";

// A spending category with productExpectation "not_allowed" (a restaurant
// meal) neither expects nor accepts a Product. Failure modes: a Product is
// linked to a restaurant meal; groceries ("not_expected") lose the ability to
// link Products; a line-level category override cannot escape the inherited
// category; a category is moved to not_allowed while Expenses in it still
// link Products.
describe("not_allowed product expectation", () => {
  const ctx = withTestDb();

  async function seed() {
    const restaurants = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Example restaurants ${crypto.randomUUID()}`,
      productExpectation: "not_allowed",
    });
    const groceries = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Example groceries ${crypto.randomUUID()}`,
      productExpectation: "not_expected",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Example noodle bar ${crypto.randomUUID()}`,
    });
    const purchaseIn = (category: typeof restaurants) =>
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-21",
        spendingCategoryId: category.id,
        spendingCategoryOrigin: "manual",
        defaultTrade: "other",
      });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: `Example chili crisp ${crypto.randomUUID()}`,
      manufacturer: "",
    });
    return { restaurants, groceries, purchaseIn, product };
  }

  const line = (
    purchaseCode: string,
    productCode: string | null,
    spendingCategoryCode: string | null = null,
  ) =>
    createRepoEntity(ctx, "expense", {
      purchaseId: purchaseCode,
      name: "Order line",
      cost: 12,
      date: "2026-09-21",
      costType: "materials",
      trade: "other",
      productId: productCode,
      productQuantity: productCode ? 1 : null,
      spendingCategoryId: spendingCategoryCode,
    });

  it("refuses a Product on a restaurant meal and allows one on groceries", async () => {
    const { restaurants, groceries, purchaseIn, product } = await seed();
    const meal = await purchaseIn(restaurants);
    await expect(line(meal.shortcode, product.shortcode)).rejects.toThrow(
      /does not allow/i,
    );
    // The meal itself, with no Product, books fine.
    await line(meal.shortcode, null);
    const shop = await purchaseIn(groceries);
    await line(shop.shortcode, product.shortcode);
  });

  it("lets a line-level category override hold a Product on a restaurant order", async () => {
    const { restaurants, groceries, purchaseIn, product } = await seed();
    const meal = await purchaseIn(restaurants);
    const { output } = await line(
      meal.shortcode,
      product.shortcode,
      groceries.shortcode,
    );
    expect(output.productId).toBe(product.shortcode);
  });

  it("refuses moving a category to not_allowed while an Expense in it links a Product", async () => {
    const { groceries, purchaseIn, product } = await seed();
    const shop = await purchaseIn(groceries);
    await line(shop.shortcode, product.shortcode);
    await expect(
      updateThroughKernel(
        ctx.db,
        ctx.actor,
        "spendingCategory",
        groceries.shortcode,
        {
          productExpectation: "not_allowed",
        },
      ),
    ).rejects.toThrow(/does not allow/i);
  });
});

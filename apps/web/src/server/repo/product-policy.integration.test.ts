import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { productCategory, runFinding } from "~/server/db/schema";
import { resolveRunFinding } from "~/server/purchase-import/findings";
import { getDb } from "~/server/repo/database-helpers";
import { linkExpensesToPurchase, mergePurchases } from "~/server/repo/purchase";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { withReviewedSpendingClassification } from "~/server/repo/spending-classification-review-authorization";
import { mergeVendors } from "~/server/repo/vendor";
import { updateThroughKernel } from "~/server/testing/entity-kernel";

// A spending category with productExpectation "not_allowed" (a restaurant
// meal) neither expects nor accepts a Product. Failure modes: a Product is
// linked to a restaurant meal; groceries ("not_expected") lose the ability to
// link Products; a line-level category override cannot escape the inherited
// category; a category is moved to not_allowed while Expenses in it still
// link Products; a write that reclassifies existing lines without touching
// them (attaching a line to another Purchase, a Vendor becoming a
// restaurant, merging into a restaurant Vendor, a merge carrying a category
// onto the keeper's own lines, an import finding relinking a Product)
// commits a forbidden link.
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

  it("refuses attaching a Product line to a restaurant Purchase", async () => {
    const { restaurants, groceries, purchaseIn, product } = await seed();
    const shop = await purchaseIn(groceries);
    const { output } = await line(shop.shortcode, product.shortcode);
    const meal = await purchaseIn(restaurants);
    await expect(
      linkExpensesToPurchase(
        ctx.db,
        { purchaseId: meal.shortcode, expenseIds: [output.id] },
        ctx.actor,
      ),
    ).rejects.toThrow(/does not allow/i);
  });

  // A restaurant Vendor's default classifies its food lines (vendor food
  // context), so food bought from a grocer moves with the Vendor.
  async function foodLineAt(vendorName: string) {
    const { restaurants } = await seed();
    const [root] = await getDb(ctx.db)
      .select({ id: productCategory.id })
      .from(productCategory)
      .where(eq(productCategory.feature, "food"))
      .limit(1);
    const food = await insertWithShortcode(ctx.db, "productCategory", {
      name: `Example pantry ${crypto.randomUUID()}`,
      parentId: root?.id ?? null,
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: `Example noodles ${crypto.randomUUID()}`,
      manufacturer: "",
      categoryId: food.id,
    });
    const grocer = await insertWithShortcode(ctx.db, "vendor", {
      name: `${vendorName} ${crypto.randomUUID()}`,
      spendingProfile: "food_retail",
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: grocer.id,
      date: "2026-09-21",
      defaultTrade: "other",
    });
    await line(order.shortcode, product.shortcode);
    return { restaurants, grocer };
  }

  it("refuses turning a Vendor with food lines into a restaurant that forbids Products", async () => {
    const { restaurants, grocer } = await foodLineAt("Example grocer");
    await expect(
      withReviewedSpendingClassification(ctx.db, () =>
        updateThroughKernel(ctx.db, ctx.actor, "vendor", grocer.shortcode, {
          spendingProfile: "restaurant",
          defaultSpendingCategoryId: restaurants.shortcode,
        }),
      ),
    ).rejects.toThrow(/does not allow/i);
  });

  it("refuses merging a Vendor with food lines into a restaurant that forbids Products", async () => {
    const { restaurants, grocer } = await foodLineAt("Example market");
    const keeper = await insertWithShortcode(ctx.db, "vendor", {
      name: `Example diner ${crypto.randomUUID()}`,
      spendingProfile: "restaurant",
      defaultSpendingCategoryId: restaurants.id,
    });
    await expect(
      mergeVendors(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [grocer.shortcode] },
        ctx.actor,
      ),
    ).rejects.toThrow(/does not allow/i);
  });

  it("refuses a Purchase merge that carries a restaurant category onto the keeper's Product line", async () => {
    const { restaurants, product } = await seed();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Example cafe ${crypto.randomUUID()}`,
    });
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-21",
      defaultTrade: "other",
    });
    await line(keeper.shortcode, product.shortcode);
    const meal = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-21",
      spendingCategoryId: restaurants.id,
      spendingCategoryOrigin: "manual",
      defaultTrade: "other",
    });
    await line(meal.shortcode, null);
    await expect(
      mergePurchases(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [meal.shortcode] },
        ctx.actor,
      ),
    ).rejects.toThrow(/does not allow/i);
  });

  it("refuses applying an import finding that relinks a Product onto a restaurant meal", async () => {
    const { restaurants, purchaseIn, product } = await seed();
    const meal = await purchaseIn(restaurants);
    const lunch = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: meal.id,
      name: "Lunch",
      cost: 12,
      date: "2026-09-21",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: `Example member ${crypto.randomUUID()}`,
      kind: "member",
      userId: ctx.actor.userId,
    });
    const [finding] = await getDb(ctx.db)
      .insert(runFinding)
      .values({
        ledgerPartyId: party.id,
        entityKind: "expense",
        entityId: lunch.id,
        kind: "wrong_product",
        summary: "The line names a pantry Product.",
        proposedFix: {
          kind: "relink_product",
          expenseId: lunch.id,
          productId: product.id,
        },
        evidenceFingerprint: crypto.randomUUID(),
      })
      .returning({ id: runFinding.id });
    if (!finding) throw new Error("test setup: finding not inserted");
    await expect(
      resolveRunFinding(ctx.db, { id: finding.id, action: "apply" }, ctx.actor),
    ).rejects.toThrow(/does not allow/i);
  });
});

import type { ProductCategoryShortcode } from "@cubby/schemas/identifiers";
import type { ProductFilters } from "@cubby/schemas/product";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { location, product } from "~/server/db/schema";
import { createProductCategory } from "~/server/domains/product-category/repo/product-category";
import { attachProductComponents } from "~/server/domains/product/repo/product-components";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { productList } from "./crud";

/**
 * Product filters compile from the declaration (#2410). Failure modes: a
 * related-path filter (stock location, kit links, serving Location) misses
 * soft deletes or descendants, a derived flag inverts or drops NULL rows, a
 * derived presence reads the wrong value, or the category filter stops
 * expanding to sub-categories.
 */
describe("product list declared filters", () => {
  const ctx = withTestDb();

  const world = async () => {
    const garage = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Parity garage",
        type: "room",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const rack = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Parity rack",
        type: "shelf",
        parentId: garage.id,
      }),
      ctx.actor,
    );
    const drivers = await createProductCategory(
      ctx.db,
      {
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
        name: "Parity drivers",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("tools"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const make = (
      name: string,
      extra: { categoryId?: ProductCategoryShortcode; price?: number } = {},
    ) =>
      createProductFixture(
        ctx.db,
        makeProductInput({ name, ...extra }),
        ctx.actor,
      );
    const driver = await make("Parity driver", {
      categoryId: drivers.output.id,
      price: 20,
    });
    const flour = await make("Parity flour", {
      categoryId: taxonomyShortcode("food"),
    });
    const misc = await make("Misc: parity odds");
    const kit = await make("Parity kit");
    const bit = await make("Parity bit");
    const tote = await make("Parity tote");
    await getDb(ctx.db)
      .update(product)
      .set({ expectedQuantity: 1, stockTracked: true })
      .where(eq(product.id, driver.entityId));
    await getDb(ctx.db)
      .update(product)
      .set({ fdc_id: 123456 })
      .where(eq(product.id, flour.entityId));
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: bit.entityId, quantity: 1 }],
      ctx.actor,
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Parity kit acquisition",
        productId: kit.id,
        productQuantity: 1,
        cost: 30,
      }),
    );
    for (const where of [rack, garage])
      await createInventoryFixture(
        ctx.db,
        {
          productId: driver.id,
          locationId: where.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    await getDb(ctx.db)
      .update(location)
      .set({ productId: tote.entityId })
      .where(eq(location.id, rack.entityId));
    await createRepoEntity(ctx, "task", {
      name: "Parity sift flour",
      subjectProductId: flour.id,
      status: "in_progress",
      trade: "other",
    });
    return { garage, rack, drivers, driver, flour, misc, kit, bit, tote };
  };

  it("narrows by each declared filter", async () => {
    const w = await world();
    const all = [w.driver, w.flour, w.misc, w.kit, w.bit, w.tote];
    const listIds = async (filters: ProductFilters) => {
      const { data } = await productList(
        ctx.db,
        { ...filters, ids: all.map(({ id }) => id) },
        [],
        { pageIndex: 0, pageSize: 50 },
      );
      return new Set<string>(data.map((row) => row.id));
    };
    const cases: Array<[ProductFilters, Array<{ id: string }>]> = [
      [{ categoryFilter: [taxonomyShortcode("tools")] }, [w.driver]],
      [{ categoryFeatureFilter: ["food"] }, [w.flour]],
      [{ categoryIdPresenceFilter: "none" }, [w.misc, w.kit, w.bit, w.tote]],
      // The family filter keeps its own No value: "food or unclassified".
      [
        { categoryFeatureFilter: ["food"], categoryPresenceFilter: "none" },
        [w.flour, w.misc, w.kit, w.bit, w.tote],
      ],
      [{ locationIdFilter: [w.garage.id] }, [w.driver]],
      [
        { locationPresenceFilter: "none" },
        [w.flour, w.misc, w.kit, w.bit, w.tote],
      ],
      [{ servingAsLocationPresenceFilter: "has" }, [w.tote]],
      [{ componentId: [w.bit.id] }, [w.kit]],
      [{ kitId: [w.kit.id] }, [w.bit]],
      [{ componentPresenceFilter: "has" }, [w.kit]],
      [{ expensePresenceFilter: "has" }, [w.kit]],
      [{ expenseCountMin: 1 }, [w.kit]],
      [{ expenseTotalMin: 25 }, [w.kit]],
      [{ pricePresenceFilter: "has" }, [w.driver, w.kit, w.bit]],
      [{ pricePresenceFilter: "none" }, [w.flour, w.misc, w.tote]],
      [{ miscBucketFilter: "has" }, [w.misc]],
      [{ usdaPresenceFilter: "has" }, [w.flour]],
      [{ inventoryMultiplicity: true }, [w.driver]],
      [
        { inventoryMultiplicity: false },
        [w.flour, w.misc, w.kit, w.bit, w.tote],
      ],
      [{ taskStatusFilter: ["in_progress"] }, [w.flour]],
      [{ taskOpenOnly: true }, [w.flour]],
      [{ stockTrackedPresenceFilter: "has" }, [w.driver]],
      // The generated sub-category toggle: on by default, off is exact.
      [
        {
          categoryFilter: [taxonomyShortcode("tools")],
          includeSubProductCategories: false,
        },
        [],
      ],
      [
        { locationIdFilter: [w.garage.id], includeSubLocations: false },
        [w.driver],
      ],
      [
        { locationIdFilter: [w.rack.id], includeSubLocations: false },
        [w.driver],
      ],
      [{ growsPlantPresenceFilter: "has" }, []],
      [{ upcFilter: "parity-none" }, []],
      // The kit's acquisition hands its component an expected unit too.
      [{ expectedQuantityMin: 1 }, [w.kit, w.bit]],
      [{ unknownQuantityLinesFilter: "has" }, []],
      [{ purchaseDatePresenceFilter: "has" }, [w.kit]],
      [
        { purchaseDatePresenceFilter: "none" },
        [w.driver, w.flour, w.misc, w.bit, w.tote],
      ],
    ];
    const failures: string[] = [];
    for (const [filters, expected] of cases) {
      const actual = await listIds(filters);
      const wanted = new Set(expected.map(({ id }) => id));
      const names = (set: Set<string>) =>
        all
          .filter(({ id }) => set.has(id))
          .map(({ name }) => name)
          .join(", ");
      if (
        actual.size !== wanted.size ||
        [...wanted].some((id) => !actual.has(id))
      )
        failures.push(
          `${JSON.stringify(filters)}: got [${names(actual)}], want [${names(wanted)}]`,
        );
    }
    expect(failures).toEqual([]);
  });
});

import { buildNutrition } from "@cubby/schemas/nutrition";
import { eq } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { recipe } from "~/server/db/schema";
import {
  listDevices,
  listDevicesRead,
} from "~/server/domains/device/repo/device";
import {
  createMealWithEntityId,
  mealList,
  mealListRead,
} from "~/server/domains/meal/repo/crud";
import { listProductCategoriesRead } from "~/server/domains/product-category/repo/product-category";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createRecipeFixture,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";

describe("progressive list readers", () => {
  const ctx = withTestDb();

  it("resolves category reference features without derived catalog, quality or media reads", async () => {
    const pagination = { pageIndex: 0, pageSize: 500 };
    const core = await countTestDbQueries(() =>
      listProductCategoriesRead(ctx.db, {}, [], pagination, { kind: "base" }),
    );
    expect(core.result.data.every((row) => !("effectiveFeature" in row))).toBe(
      true,
    );
    const references = await countTestDbQueries(() =>
      listProductCategoriesRead(ctx.db, {}, [], pagination, {
        kind: "enrichment",
        groups: ["relations"],
      }),
    );
    expect(
      references.result.data.find(
        (row) => row.id === taxonomyShortcode("tools"),
      ),
    ).toMatchObject({ effectiveFeature: "tools" });
    expect(
      references.tables.filter(
        (table) =>
          /^[A-Z]/.test(table) &&
          !["ProductCategory", "SpendingCategory"].includes(table),
      ),
    ).toEqual([]);
    for (const row of references.result.data) {
      expect(row).not.toHaveProperty("fieldResolutions");
      expect(row).not.toHaveProperty("productCount");
      expect(row).not.toHaveProperty("spendingCategoryMapping");
      expect(row).not.toHaveProperty("dataQuality");
      expect(row).not.toHaveProperty("displayImages");
    }
    const empty = await countTestDbQueries(() =>
      listProductCategoriesRead(
        ctx.db,
        { search: "Synthetic nonexistent category vocabulary" },
        [],
        pagination,
        { kind: "enrichment", groups: ["relations"] },
      ),
    );
    expect(empty.result.data).toEqual([]);
    expect(empty.queryCount).toBe(core.queryCount);
  });

  // Reading core scalars must not resolve FKs, score quality, or resolve media;
  // partial patches must agree with the corresponding fields of the full read.
  it("keeps device core to the page queries and loads only requested reference or quality patches", async () => {
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic progressive owner",
      kind: "member",
    });
    const hardware = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic progressive hardware",
      brandId: await findOrCreateVendor(ctx.db, "Synthetic brandName"),
      stockTracked: false,
      usdaUnavailable: false,
    });
    const created = await insertWithShortcode(ctx.db, "device", {
      name: "Synthetic progressive device",
      installationId: crypto.randomUUID(),
      platform: "ios",
      ledgerPartyId: owner.id,
      productId: hardware.id,
      automaticWork: true,
      remotePaused: false,
    });
    const pagination = { pageIndex: 0, pageSize: 25 };
    const full = await listDevices(ctx.db, {}, [], pagination);
    const core = await countTestDbQueries(() =>
      listDevicesRead(ctx.db, {}, [], pagination, { kind: "base" }),
    );
    expect(core.queryCount).toBe(2);
    expect(core.result.count).toBe(full.count);
    expect(core.result.data[0]).toMatchObject({
      id: created.shortcode,
      name: created.name,
    });
    expect(core.result.data[0]).not.toHaveProperty("productId");
    expect(core.result.data[0]).not.toHaveProperty("dataQuality");
    expect(JSON.stringify(core.result.data)).not.toContain(created.id);

    const references = await countTestDbQueries(() =>
      listDevicesRead(ctx.db, {}, [], pagination, {
        kind: "enrichment",
        groups: ["relations"],
      }),
    );
    expect(references.queryCount).toBe(4);
    expect(references.result.data[0]).toEqual({
      id: created.shortcode,
      ledgerPartyId: owner.shortcode,
      ledgerPartyName: owner.name,
      productId: hardware.shortcode,
      productName: hardware.name,
    });
    const quality = await countTestDbQueries(() =>
      listDevicesRead(ctx.db, {}, [], pagination, {
        kind: "enrichment",
        groups: ["quality"],
      }),
    );
    expect(quality.queryCount).toBe(3);
    expect(quality.result.data[0]).toEqual({
      id: created.shortcode,
      dataQuality: full.data[0]?.dataQuality,
    });
    expect({
      ...core.result.data[0],
      ...references.result.data[0],
      ...quality.result.data[0],
    }).toEqual(full.data[0]);
  });

  it("awaits meal recipe dependencies for derived totals without emitting relation fields or loading quality and images", async () => {
    const planned = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic projection dependency" }),
      ctx.actor,
    );
    const created = await createMealWithEntityId(
      ctx.db,
      {
        date: "2026-01-01",
        name: "Synthetic derived meal",
        recipes: [{ recipeId: planned.id, scale: 2 }],
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(recipe)
      .set({
        totals: {
          cost: {
            status: "complete",
            lower: 12,
            upper: null,
            coverage: { covered: 1, total: 1 },
          },
          nutrition: buildNutrition(() => ({
            status: "complete",
            lower: 100,
            upper: null,
            coverage: { covered: 1, total: 1 },
          })),
        },
        totalsComputedAt: new Date(),
      })
      .where(eq(recipe.id, planned.entityId));
    const pagination = { pageIndex: 0, pageSize: 25 };
    const full = await mealList(ctx.db, {}, [], pagination);
    const measured = await countTestDbQueries(() =>
      mealListRead(ctx.db, {}, [], pagination, "page", {
        kind: "enrichment",
        groups: ["derived"],
      }),
    );
    // Selection/count share one statement; recipe dependencies load by page IDs.
    expect(measured.queryCount).toBe(2);
    expect(measured.result.data[0]).toMatchObject({
      id: created.output.id,
      totals: { cost: { lower: 24 } },
    });
    expect(measured.result.data[0]).toEqual({
      id: created.output.id,
      totals: full.data[0]?.totals,
      costTotalLabel: full.data[0]?.costTotalLabel,
      cost: full.data[0]?.cost,
      calories: full.data[0]?.calories,
    });
    expect(measured.result.data[0]).not.toHaveProperty("recipes");
    expect(measured.result.data[0]).not.toHaveProperty("dataQuality");
    expect(measured.result.data[0]).not.toHaveProperty("images");
  });
});

import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  upsertCookbook,
  setCookbookProduct,
} from "~/server/domains/cookbook/repo/cookbook";
import { createProductCategory } from "~/server/domains/product-category/repo/product-category";
import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createLocationFixture,
  createProductFixture,
  makeCookbookExtraction,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { readProductDetail } from "./detail";

let queue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  queue = captureBackgroundQueue();
});
afterEach(() => queue.restore());

describe("Product linked references and category behavior", () => {
  const ctx = withTestDb();
  it("keeps compact category/book identity, current inherited feature and bounded Location fields with constant duplicate cost", async () => {
    const category = await createProductCategory(
      ctx.db,
      {
        name: "Synthetic storage group",
        aliases: [],
        description: null,
        sortOrder: 0,
        parentId: taxonomyShortcode("storage"),
        feature: null,
        spendingCategoryMode: "inherit",
        spendingCategoryId: null,
      },
      ctx.actor,
    );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic nested storage crate",
        categoryId: category.output.id,
      }),
      ctx.actor,
    );
    const parent = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic crate room", type: "room" }),
      ctx.actor,
    );
    const child = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic linked crate",
        type: "box",
        parentId: parent.id,
        productId: product.id,
      }),
      ctx.actor,
    );
    const book = await upsertCookbook(
      ctx.db,
      {
        name: "Synthetic linked book",
        sourceLabel: "synthetic.epub",
        rawJson: makeCookbookExtraction(),
      },
      ctx.actor,
    );
    await setCookbookProduct(
      ctx.db,
      ctx.actor,
      book.entityId,
      product.entityId,
    );
    const context = createTestRequestContext(ctx.db);
    const raw = await readProductDetail(
      { db: ctx.db, usdaClient: context.usdaClient },
      product.id,
    );
    if (!raw) throw new Error("Synthetic raw Product detail missing");
    expect(raw.category?.feature).toBe("storage");
    const read = (count: number) =>
      countTestDbQueries(() =>
        readPublicEntityRows({
          db: ctx.db,
          entity: "product",
          projection: "detail",
          rows: Array.from({ length: count }, () => raw),
        }),
      );
    const single = await read(1);
    const repeated = await read(20);
    expect(repeated.queryCount).toBe(single.queryCount);
    for (const item of repeated.result) {
      expect(item.category?.id).toBe(category.output.id);
      expect(item.category?.path.map((node) => node.name)).toContain(
        "Synthetic storage group",
      );
      expect(item.category).not.toHaveProperty("feature");
      expect(fieldValueOf(item.fields.categoryFeature)).toBe("storage");
      const locations = fieldValueOf(item.fields.servingAsLocations);
      const linked = locations?.find((location) => location.id === child.id);
      if (!linked) throw new Error("Synthetic serving-as Location missing");
      expect(fieldValueOf(linked.fields.type)).toBe("box");
      expect(linked).not.toHaveProperty("type");
      const ancestor = linked.ancestors.find(
        (location) => location.id === parent.id,
      );
      if (!ancestor) throw new Error("Synthetic Location ancestor missing");
      expect(fieldValueOf(ancestor.fields.type)).toBe("room");
      expect(ancestor).not.toHaveProperty("type");
      expect(item.cookbooks).toEqual([
        { id: expect.any(String), name: "Synthetic linked book" },
      ]);
      expect(item.cookbooks[0]).not.toHaveProperty("recipeCount");
    }
  });
});

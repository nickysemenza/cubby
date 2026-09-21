import { sql } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import {
  createProductCategory,
  deleteProductCategories,
  listProductCategoryTreeOptions,
  updateProductCategory,
} from "./product-category";
import { categoryDescendantsSql } from "./product-category-sql";

const ctx = withTestDb();

describe("product category hierarchy", () => {
  it("returns a root-first path and rejects a cycle or fourth level", async () => {
    const root = await createProductCategory(
      ctx.db,
      {
        name: "Custom root",
        aliases: [],
        description: null,
        parentId: null,
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const group = await createProductCategory(
      ctx.db,
      {
        name: "Custom group",
        aliases: [],
        description: null,
        parentId: root.output.id,
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const type = await createProductCategory(
      ctx.db,
      {
        name: "Custom type",
        aliases: [],
        description: null,
        parentId: group.output.id,
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );

    const option = (await listProductCategoryTreeOptions(ctx.db)).find(
      (item) => item.id === type.output.id,
    );
    expect(option?.path.map((part) => part.name)).toEqual([
      "Custom root",
      "Custom group",
      "Custom type",
    ]);

    await expect(
      updateProductCategory(
        ctx.db,
        root.output.id,
        { parentId: type.output.id },
        ctx.actor,
      ),
    ).rejects.toThrow("descendants");
    await expect(
      createProductCategory(
        ctx.db,
        {
          name: "Too deep",
          aliases: [],
          description: null,
          parentId: type.output.id,
          sortOrder: 0,
          feature: null,
        },
        ctx.actor,
      ),
    ).rejects.toThrow("at most 3 levels");

    const destinationRoot = await createProductCategory(
      ctx.db,
      {
        name: "Destination root",
        aliases: [],
        description: null,
        parentId: null,
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const destinationGroup = await createProductCategory(
      ctx.db,
      {
        name: "Destination group",
        aliases: [],
        description: null,
        parentId: destinationRoot.output.id,
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    await expect(
      updateProductCategory(
        ctx.db,
        group.output.id,
        { parentId: destinationGroup.output.id },
        ctx.actor,
      ),
    ).rejects.toThrow("at most 3 levels");

    const descendants = await getDb(ctx.db).execute<{ id: string }>(sql`
      SELECT "id"::text AS "id" FROM "ProductCategory"
      WHERE "id" IN ${categoryDescendantsSql([root.entityId])}
      ORDER BY "id"
    `);
    expect(descendants.rows).toHaveLength(3);

    await updateProductCategory(
      ctx.db,
      root.output.id,
      { name: "Renamed custom root" },
      ctx.actor,
    );
    const renamed = (await listProductCategoryTreeOptions(ctx.db)).find(
      (item) => item.id === type.output.id,
    );
    expect(renamed?.path).toEqual([
      { id: root.output.id, name: "Renamed custom root" },
      { id: group.output.id, name: "Custom group" },
      { id: type.output.id, name: "Custom type" },
    ]);
  });

  it("retains behavior roots and rejects duplicate feature bindings", async () => {
    await expect(
      deleteProductCategories(ctx.db, [taxonomyShortcode("food")], ctx.actor),
    ).rejects.toThrow("behavior binding");
    await expect(
      updateProductCategory(
        ctx.db,
        taxonomyShortcode("food"),
        { parentId: taxonomyShortcode("tools") },
        ctx.actor,
      ),
    ).rejects.toThrow("behavior binding");

    await expect(
      createProductCategory(
        ctx.db,
        {
          name: "Second food root",
          aliases: [],
          description: null,
          parentId: null,
          sortOrder: 0,
          feature: "food",
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "ProductCategory_feature_live_unique" },
    });
  });

  it("rejects moving food or ISBN subtrees away from their evidence roots", async () => {
    const foodType = await createProductCategory(
      ctx.db,
      {
        name: "Evidence food type",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("food"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const bookType = await createProductCategory(
      ctx.db,
      {
        name: "Evidence book type",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("books"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const unboundRoot = await createProductCategory(
      ctx.db,
      {
        name: "Unbound evidence destination",
        aliases: [],
        description: null,
        parentId: null,
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Food evidence category product",
        categoryId: foodType.output.id,
        fdc_id: 880001,
      }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "ISBN evidence category product",
        categoryId: bookType.output.id,
        upc: "9780306406157",
      }),
      ctx.actor,
    );

    await expect(
      updateProductCategory(
        ctx.db,
        foodType.output.id,
        { parentId: unboundRoot.output.id },
        ctx.actor,
      ),
    ).rejects.toThrow("would invalidate an assigned Product");
    await expect(
      updateProductCategory(
        ctx.db,
        bookType.output.id,
        { parentId: unboundRoot.output.id },
        ctx.actor,
      ),
    ).rejects.toThrow("would invalidate an assigned Product");
  });
});

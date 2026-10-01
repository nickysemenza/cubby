import type { ProductCategoryShortcode } from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { eq, inArray, sql } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  product as productTable,
  productCategory,
  project,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createExpense } from "~/server/repo/expense";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";

import {
  createProductCategory,
  getProductCategoryByShortcode,
  listProductCategories,
  listProductCategoryTreeOptions,
  updateProductCategory,
} from "./product-category";
import { categoryDescendantsSql } from "./product-category-sql";

const ctx = withTestDb();

describe("product category hierarchy", () => {
  it("counts live products across a subtree and reports the inherited feature", async () => {
    const group = await createProductCategory(
      ctx.db,
      {
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
        name: "Counted group",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("tools"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const type = await createProductCategory(
      ctx.db,
      {
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
        name: "Counted type",
        aliases: [],
        description: null,
        parentId: group.output.id,
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Group product", categoryId: group.output.id }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Type product", categoryId: type.output.id }),
      ctx.actor,
    );
    const removed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Removed product", categoryId: type.output.id }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(productTable)
      .set({ deletedAt: new Date() })
      .where(eq(productTable.id, removed.entityId));

    const { data } = await listProductCategories(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 500,
    });
    const listed = new Map(data.map((row) => [row.id, row]));
    expect(listed.get(type.output.id)?.productCount).toBe(1);
    expect(listed.get(group.output.id)?.productCount).toBe(2);
    expect(
      listed.get(taxonomyShortcode("tools"))?.productCount,
    ).toBeGreaterThanOrEqual(2);
    expect(
      listed.get(taxonomyShortcode("tools"))?.fieldResolutions?.feature,
    ).toMatchObject({ mode: "explicit", value: "tools", fallbackValue: null });

    const detail = await getProductCategoryByShortcode(ctx.db, type.output.id);
    expect(detail?.productCount).toBe(1);
    expect(detail?.feature).toBeNull();
    expect(detail?.fieldResolutions?.feature).toMatchObject({
      mode: "inherit",
      value: "tools",
      sourceEntity: {
        entityKind: "productCategory",
        entityId: taxonomyShortcode("tools"),
      },
    });
  });

  it("preserves permanent feature intent and resolves live ancestry after moves", async () => {
    // Feature bindings are globally unique; reserve these seeded bindings for this fixture.
    await getDb(ctx.db)
      .update(productCategory)
      .set({ feature: null })
      .where(
        inArray(productCategory.feature, ["books", "tools", "electronics"]),
      );
    const create = (
      name: string,
      feature: "books" | "tools" | "electronics" | null,
      parentId: ProductCategoryShortcode | null = null,
    ) =>
      createProductCategory(
        ctx.db,
        {
          spendingCategoryId: null,
          spendingCategoryMode: "inherit",
          name,
          aliases: [],
          description: null,
          parentId,
          sortOrder: 0,
          feature,
        },
        ctx.actor,
      );
    const parent = await create("Synthetic feature parent", "books");
    const otherParent = await create(
      "Synthetic alternate parent",
      "electronics",
    );
    const child = await create(
      "Synthetic feature child",
      "tools",
      parent.output.id,
    );
    const inheriting = await create(
      "Synthetic inherited child",
      null,
      parent.output.id,
    );
    const read = () => getProductCategoryByShortcode(ctx.db, child.output.id);
    expect((await read())?.fieldResolutions?.feature).toMatchObject({
      mode: "explicit",
      storedValue: "tools",
      value: "tools",
      fallbackValue: "books",
      matchesFallback: false,
      canReset: false,
    });
    for (const feature of ["books", null] as const) {
      await expect(
        updateProductCategory(ctx.db, child.output.id, { feature }, ctx.actor),
      ).rejects.toThrow(
        "A category behavior binding cannot be cleared or replaced",
      );
      expect((await read())?.feature).toBe("tools");
    }
    await updateProductCategory(
      ctx.db,
      child.output.id,
      { parentId: otherParent.output.id },
      ctx.actor,
    );
    expect((await read())?.fieldResolutions?.feature).toMatchObject({
      mode: "explicit",
      value: "tools",
      fallbackValue: "electronics",
      canReset: false,
    });
    expect(
      (await getProductCategoryByShortcode(ctx.db, inheriting.output.id))
        ?.fieldResolutions?.feature,
    ).toMatchObject({
      mode: "inherit",
      storedValue: null,
      value: "books",
      canReset: false,
      sourceEntity: { entityId: parent.output.id },
    });
    await updateProductCategory(
      ctx.db,
      inheriting.output.id,
      { parentId: otherParent.output.id },
      ctx.actor,
    );
    expect(
      (await getProductCategoryByShortcode(ctx.db, inheriting.output.id))
        ?.fieldResolutions?.feature,
    ).toMatchObject({
      mode: "inherit",
      value: "electronics",
      sourceEntity: { entityId: otherParent.output.id },
    });
    await updateProductCategory(
      ctx.db,
      child.output.id,
      { parentId: null },
      ctx.actor,
    );
    expect((await read())?.fieldResolutions?.feature).toMatchObject({
      mode: "explicit",
      value: "tools",
      fallbackValue: null,
      canReset: false,
    });
    // Legacy deleted ancestry must never remain an effective source.
    await getDb(ctx.db)
      .update(productCategory)
      .set({ deletedAt: new Date() })
      .where(eq(productCategory.id, otherParent.entityId));
    expect(
      (await getProductCategoryByShortcode(ctx.db, inheriting.output.id))
        ?.fieldResolutions?.feature,
    ).toMatchObject({
      mode: "inherit",
      value: null,
      fallbackValue: null,
      sourceEntity: null,
      canReset: false,
    });
  });

  it("returns a root-first path and rejects a cycle or fourth level", async () => {
    const root = await createProductCategory(
      ctx.db,
      {
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
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
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
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
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
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
          spendingCategoryId: null,
          spendingCategoryMode: "inherit",
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
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
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
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
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

  it("keeps a nested binding permanent and rejects duplicate feature bindings", async () => {
    // A bound category nests under another tree (Tools › Tool consumables)
    // and keeps its own feature rather than inheriting the parent's.
    const nested = await updateProductCategory(
      ctx.db,
      taxonomyShortcode("tool-consumables"),
      { parentId: taxonomyShortcode("tools") },
      ctx.actor,
    );
    expect(nested.output.feature).toBe("tool-consumables");
    const option = (await listProductCategoryTreeOptions(ctx.db)).find(
      (item) => item.id === nested.output.id,
    );
    expect(option?.feature).toBe("tool-consumables");

    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "productCategory", [
        taxonomyShortcode("tool-consumables"),
      ]),
    ).rejects.toThrow("behavior binding");
    await expect(
      updateProductCategory(
        ctx.db,
        taxonomyShortcode("tool-consumables"),
        { feature: null },
        ctx.actor,
      ),
    ).rejects.toThrow("behavior binding");
    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "productCategory", [
        taxonomyShortcode("food"),
      ]),
    ).rejects.toThrow("behavior binding");

    await expect(
      createProductCategory(
        ctx.db,
        {
          spendingCategoryId: null,
          spendingCategoryMode: "inherit",
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
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
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
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
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
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
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

  it("refuses a food move that would remove an inherited household trade", async () => {
    const foodType = await createProductCategory(
      ctx.db,
      {
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
        name: "Inherited trade food type",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("food"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const destination = await createProductCategory(
      ctx.db,
      {
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
        name: "Inherited trade destination",
        aliases: [],
        description: null,
        parentId: null,
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .insert(project)
      .values({
        shortcode: testShortcode("project", "PRJ-HSHD"),
        name: "Household project",
        defaultTrade: "building",
      });
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Food product with inherited trade",
        categoryId: foodType.output.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Food principal inheriting household trade",
        productId: product.id,
        trade: null,
      }),
      ctx.actor,
    );

    await expect(
      updateProductCategory(
        ctx.db,
        foodType.output.id,
        { parentId: destination.output.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });

    const persisted = (await listProductCategoryTreeOptions(ctx.db)).find(
      (item) => item.id === foodType.output.id,
    );
    expect(persisted?.path.map((part) => part.id)).toEqual([
      taxonomyShortcode("food"),
      foodType.output.id,
    ]);
  });
});

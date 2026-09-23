import type { ProductCategoryShortcode } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { productCategory } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createLedgerParty,
  listLedgerParties,
} from "~/server/repo/ledger-party";
import { locationList } from "~/server/repo/location/crud";
import { createProductCategory } from "~/server/repo/product-category";
import { productList } from "~/server/repo/product/crud";
import {
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

const ctx = withTestDb();
const groups = (result: {
  count: number;
  groups?: { key: string; label: string; count: number }[];
}) => result.groups;
const groupedProducts = (
  sort: Parameters<typeof productList>[2],
  pageIndex: number,
  pageSize: number,
) => productList(ctx.db, {}, sort, { pageIndex, pageSize }, "category");
async function category(name: string, sortOrder: number) {
  return createProductCategory(
    ctx.db,
    {
      name,
      aliases: [],
      description: null,
      parentId: taxonomyShortcode("tools"),
      sortOrder,
      feature: null,
    },
    ctx.actor,
  );
}

async function product(
  name: string,
  categoryId: ProductCategoryShortcode | null,
) {
  return createProductFixture(
    ctx.db,
    makeProductInput({ name, categoryId }),
    ctx.actor,
  );
}

async function location(name: string, type: "room" | "box") {
  return createLocationFixture(
    ctx.db,
    makeLocationInput({ name, type }),
    ctx.actor,
  );
}

describe("server list grouping", () => {
  it("orders Product categories before pagination and reports full paths and counts", async () => {
    const alpha = await category("Alpha group", 0);
    const beta = await category("Beta group", 1);
    await product("Beta item", beta.output.id);
    await product("Alpha item", alpha.output.id);
    await product("Unclassified item", null);

    const pages = await Promise.all(
      [0, 1, 2].map((index) =>
        groupedProducts([{ orderBy: "name", direction: "asc" }], index, 1),
      ),
    );
    expect(pages.map((result) => result.data[0]?.name)).toEqual([
      "Alpha item",
      "Beta item",
      "Unclassified item",
    ]);
    expect(groups(pages[0]!)).toEqual([
      expect.objectContaining({
        key: alpha.output.id,
        count: 1,
        label: expect.stringContaining("Alpha group"),
      }),
      expect.objectContaining({
        key: beta.output.id,
        count: 1,
        label: expect.stringContaining("Beta group"),
      }),
      { key: "__unclassified__", label: "Unclassified", count: 1 },
    ]);

    const result = await groupedProducts(
      [
        { orderBy: "name", direction: "asc" },
        { orderBy: "category", direction: "desc" },
      ],
      0,
      3,
    );
    expect(groups(result)?.map((group) => group.key)).toEqual([
      beta.output.id,
      alpha.output.id,
      "__unclassified__",
    ]);
    expect(result.data.map((row) => row.name)).toEqual([
      "Beta item",
      "Alpha item",
      "Unclassified item",
    ]);
  });

  it("collapses Products with a deleted category into the unclassified group", async () => {
    const retired = await category("Retired group", 0);
    await product("Retired item", retired.output.id);
    await product("No category item", null);
    await getDb(ctx.db)
      .update(productCategory)
      .set({ deletedAt: new Date() })
      .where(eq(productCategory.id, retired.entityId));

    const result = await groupedProducts(
      [{ orderBy: "name", direction: "asc" }],
      0,
      10,
    );
    expect(groups(result)).toEqual([
      { key: "__unclassified__", label: "Unclassified", count: 2 },
    ]);
    expect(result.data.map((row) => row.name)).toEqual([
      "No category item",
      "Retired item",
    ]);
  });

  it("sorts Location groups before pagination and reports all filtered counts", async () => {
    await location("Room one", "room");
    await location("Room two", "room");
    await location("Box one", "box");

    const result = await locationList(
      ctx.db,
      { itemTypeFilter: ["box", "room"] },
      [
        { orderBy: "name", direction: "asc" },
        { orderBy: "type", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 1 },
      "type",
    );
    expect(result.data[0]?.name).toBe("Room one");
    expect(groups(result)).toEqual([
      { key: "room", label: "room", count: 2 },
      { key: "box", label: "box", count: 1 },
    ]);
  });

  it("applies Ledger Party secondary sorts before its stable tie breaker", async () => {
    for (const [name, kind] of [
      ["Alpha", "guest"],
      ["Beta", "guest"],
      ["Gamma", "member"],
    ] as const) {
      await createLedgerParty(ctx.db, { name, kind, notes: null }, ctx.actor);
    }

    const result = await listLedgerParties(
      ctx.db,
      {},
      [
        { orderBy: "kind", direction: "asc" },
        { orderBy: "name", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(result.data.map((row) => row.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
  });
});

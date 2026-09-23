import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { productCategory as productCategoryTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  listLedgerParties,
  createLedgerParty,
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
const page = (pageIndex: number) => ({ pageIndex, pageSize: 1 });

describe("server list grouping", () => {
  it("orders Product categories before pagination and reports full category paths and counts", async () => {
    const alpha = await createProductCategory(
      ctx.db,
      {
        name: "Alpha group",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("tools"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const beta = await createProductCategory(
      ctx.db,
      {
        name: "Beta group",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("tools"),
        sortOrder: 1,
        feature: null,
      },
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Beta item", categoryId: beta.output.id }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Alpha item", categoryId: alpha.output.id }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unclassified item", categoryId: null }),
      ctx.actor,
    );

    const pages = [];
    for (const index of [0, 1, 2]) {
      pages.push(
        await productList(
          ctx.db,
          {},
          [{ orderBy: "name", direction: "asc" }],
          page(index),
          "category",
        ),
      );
    }
    expect(pages.map((result) => result.data[0]?.name)).toEqual([
      "Alpha item",
      "Beta item",
      "Unclassified item",
    ]);
    const firstPage = pages[0]!;
    expect("groups" in firstPage ? firstPage.groups : undefined).toEqual([
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
  });

  it("honors descending group-field sort while keeping the unclassified group last", async () => {
    const alpha = await createProductCategory(
      ctx.db,
      {
        name: "Alpha group",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("tools"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const beta = await createProductCategory(
      ctx.db,
      {
        name: "Beta group",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("tools"),
        sortOrder: 1,
        feature: null,
      },
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Alpha item", categoryId: alpha.output.id }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Beta item", categoryId: beta.output.id }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unclassified item", categoryId: null }),
      ctx.actor,
    );

    const result = await productList(
      ctx.db,
      {},
      [
        { orderBy: "name", direction: "asc" },
        { orderBy: "category", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 3 },
      "category",
    );
    const descendingGroups = "groups" in result ? result.groups : undefined;
    expect(descendingGroups?.map((group) => group.key)).toEqual([
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

  it("merges products with an unavailable category into one unclassified group", async () => {
    const retired = await createProductCategory(
      ctx.db,
      {
        name: "Retired group",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("tools"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Retired item", categoryId: retired.output.id }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "No category item", categoryId: null }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(productCategoryTable)
      .set({ deletedAt: new Date() })
      .where(eq(productCategoryTable.id, retired.entityId));

    const result = await productList(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 10 },
      "category",
    );
    const groups = "groups" in result ? result.groups : undefined;
    expect(groups).toEqual([
      { key: "__unclassified__", label: "Unclassified", count: 2 },
    ]);
    expect(result.data.map((row) => row.name)).toEqual([
      "No category item",
      "Retired item",
    ]);
  });

  it("orders Location types before pagination and reports all filtered type counts", async () => {
    await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Room one", type: "room" }),
      ctx.actor,
    );
    await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Room two", type: "room" }),
      ctx.actor,
    );
    await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Box one", type: "box" }),
      ctx.actor,
    );

    const first = await locationList(
      ctx.db,
      { itemTypeFilter: ["box", "room"] },
      [{ orderBy: "name", direction: "desc" }],
      page(0),
      "type",
    );
    expect(first.data[0]?.name).toBe("Box one");
    expect("groups" in first ? first.groups : undefined).toEqual([
      { key: "box", label: "box", count: 1 },
      { key: "room", label: "room", count: 2 },
    ]);
  });

  it("honors a descending Location type sort before row sorts", async () => {
    await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Room", type: "room" }),
      ctx.actor,
    );
    await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Box", type: "box" }),
      ctx.actor,
    );
    const result = await locationList(
      ctx.db,
      { itemTypeFilter: ["box", "room"] },
      [
        { orderBy: "name", direction: "asc" },
        { orderBy: "type", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 2 },
      "type",
    );
    const groups = "groups" in result ? result.groups : undefined;
    expect(groups?.map((group) => group.key)).toEqual(["room", "box"]);
    expect(result.data.map((row) => row.name)).toEqual(["Room", "Box"]);
  });

  it("applies Ledger Party secondary sorts before its stable tie breaker", async () => {
    await createLedgerParty(
      ctx.db,
      { name: "Alpha", kind: "guest", notes: null },
      ctx.actor,
    );
    await createLedgerParty(
      ctx.db,
      { name: "Beta", kind: "guest", notes: null },
      ctx.actor,
    );
    await createLedgerParty(
      ctx.db,
      { name: "Gamma", kind: "member", notes: null },
      ctx.actor,
    );

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
import { eq } from "drizzle-orm";

import type { ProductCategoryShortcode } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { ledgerParty, productCategory } from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
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
import { createTestRequestContext } from "~/server/testing/request-context";

const ctx = withTestDb();
const groups = (result: {
  count: number;
  groups?: { key: string; label: string; count: number }[];
}) => result.groups;
const groupedProducts = (
  sort: Parameters<typeof productList>[2],
  pageIndex: number,
  pageSize: number,
) => productList(ctx.db, {}, sort, { pageIndex, pageSize }, "categoryId");
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
    const betaProduct = await product("Beta item", beta.output.id);
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
        { orderBy: "categoryId", direction: "desc" },
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

    const kernelContext = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const grouped = await executeEntity(kernelContext, {
      action: "list",
      entity: "product",
      filters: {},
      groupBy: "categoryId",
      pagination: { pageIndex: 0, pageSize: 1 },
    });
    expect(grouped.meta.groups).toEqual(groups(pages[0]!));
    const restricted = await executeEntity(kernelContext, {
      action: "list",
      entity: "product",
      filters: { ids: [betaProduct.id] },
      groupBy: "categoryId",
      pagination: { pageIndex: 0, pageSize: 1 },
    });
    expect(restricted.meta.groups).toBeUndefined();

    const categories = await executeEntity(kernelContext, {
      action: "list",
      entity: "productCategory",
      filters: {},
      pagination: { pageIndex: 0, pageSize: 100 },
    });
    const ids = categories.items.map((item) => item.id);
    expect(ids.indexOf(alpha.output.id)).toBeLessThan(
      ids.indexOf(beta.output.id),
    );
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
    const older = await createLedgerParty(
      ctx.db,
      { name: "Alpha", kind: "guest", notes: null },
      ctx.actor,
    );
    const newer = await createLedgerParty(
      ctx.db,
      { name: "Alpha", kind: "guest", notes: null },
      ctx.actor,
    );
    for (const [id, date] of [
      [older.entityId, "2020-01-01T00:00:00.000Z"],
      [newer.entityId, "2021-01-01T00:00:00.000Z"],
    ] as const) {
      await getDb(ctx.db)
        .update(ledgerParty)
        .set({ createdAt: new Date(date) })
        .where(eq(ledgerParty.id, id));
    }
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
        { orderBy: "createdAt", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(result.data.map((row) => row.name)).toEqual([
      "Beta",
      "Alpha",
      "Alpha",
      "Gamma",
    ]);
    expect(result.data.slice(1, 3).map((row) => row.id)).toEqual([
      newer.output.id,
      older.output.id,
    ]);
  });
});

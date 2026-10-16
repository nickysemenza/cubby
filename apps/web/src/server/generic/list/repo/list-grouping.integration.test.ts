import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ProductCategoryShortcode } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { ledgerParty, productCategory } from "~/server/db/schema";
import {
  createLedgerParty,
  listLedgerParties,
} from "~/server/domains/ledger-party/repo/ledger-party";
import { locationList } from "~/server/domains/location/repo/crud";
import { createProductCategory } from "~/server/domains/product-category/repo/product-category";
import { productList } from "~/server/domains/product/repo/crud";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { withListGroupBy } from "~/server/generic/list/repo/list";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

const ctx = withTestDb();
const groups = (result: {
  count: number;
  groups?: { key: string; label: string; count: number }[];
}) => result.groups;
// The kernel carries a validated `groupBy` beside the filters, like `nesting`.
const groupedProducts = (
  sort: Parameters<typeof productList>[2],
  pageIndex: number,
  pageSize: number,
) =>
  productList(ctx.db, withListGroupBy({}, "categoryId"), sort, {
    pageIndex,
    pageSize,
  });
const kernel = () =>
  entityKernelContextSchema.parse(
    createTestRequestContext(ctx.db, {
      auth: { userId: testUserId("test-user-id") },
    }),
  );
async function category(name: string, sortOrder: number) {
  return createProductCategory(
    ctx.db,
    {
      spendingCategoryId: null,
      spendingCategoryMode: "inherit",
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
  it("keeps related-key sections contiguous across pages, no-value last, with counts that match the rows", async () => {
    const alpha = await category("Alpha shelf group", 0);
    const beta = await category("Beta shelf group", 1);
    const shelf = await location("Grouping shelf", "box");
    const entries: Awaited<ReturnType<typeof createInventoryFixture>>[] = [];
    // Created out of section order, so only the group-first ORDER BY puts
    // the rows together.
    for (const [name, categoryId] of [
      ["Beta one", beta.output.id],
      ["No category one", null],
      ["Alpha two", alpha.output.id],
      ["Alpha one", alpha.output.id],
    ] as const) {
      const item = await product(name, categoryId);
      entries.push(
        await createInventoryFixture(
          ctx.db,
          {
            productId: item.id,
            locationId: shelf.id,
            amount: { value: 1, unit: "each" },
          },
          ctx.actor,
        ),
      );
    }
    const read = (pageIndex: number, pageSize: number) =>
      executeEntity(kernel(), {
        action: "list",
        entity: "inventory",
        filters: { ids: entries.map((entry) => entry.id) },
        sort: [{ orderBy: "product", direction: "asc" }],
        groupBy: "category",
        pagination: { pageIndex, pageSize },
      });
    const sections = [
      { key: alpha.output.id, label: "Alpha shelf group", count: 2 },
      { key: beta.output.id, label: "Beta shelf group", count: 1 },
      { key: FILTER_NONE, label: "No category", count: 1 },
    ];
    // A page boundary inside the Alpha section, then one before No category.
    for (const pageSize of [1, 3]) {
      const pages = await Promise.all(
        Array.from({ length: Math.ceil(4 / pageSize) }, (_, index) =>
          read(index, pageSize),
        ),
      );
      for (const page of pages) expect(page.meta.groups).toEqual(sections);
      const names = pages.flatMap((page) =>
        page.items.map(
          (item) =>
            z.object({ displayName: z.string() }).parse(item).displayName,
        ),
      );
      expect(names.map((name) => name.split(" · ")[0])).toEqual([
        "Alpha one",
        "Alpha two",
        "Beta one",
        "No category one",
      ]);
      expect(sections.reduce((sum, section) => sum + section.count, 0)).toBe(
        pages[0]!.meta.totalCount,
      );
    }
  });

  it("orders Product categories before pagination and reports their names and counts", async () => {
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
      { key: alpha.output.id, count: 1, label: "Alpha group" },
      { key: beta.output.id, count: 1, label: "Beta group" },
      { key: FILTER_NONE, label: "No category", count: 1 },
    ]);

    // Sections keep label order whatever the row sort says.
    const result = await groupedProducts(
      [
        { orderBy: "name", direction: "desc" },
        { orderBy: "categoryId", direction: "desc" },
      ],
      0,
      3,
    );
    expect(groups(result)?.map((group) => group.key)).toEqual([
      alpha.output.id,
      beta.output.id,
      FILTER_NONE,
    ]);
    expect(result.data.map((row) => row.name)).toEqual([
      "Alpha item",
      "Beta item",
      "Unclassified item",
    ]);

    const kernelContext = kernel();
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
    expect(restricted.meta.groups).toEqual([
      { key: beta.output.id, count: 1, label: "Beta group" },
    ]);
    expect(restricted.meta.totalCount).toBe(1);

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

  it("collapses Products with a deleted category into the no-value section", async () => {
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
      { key: FILTER_NONE, label: "No category", count: 2 },
    ]);
    expect(result.data.map((row) => row.name)).toEqual([
      "No category item",
      "Retired item",
    ]);
  });

  it("orders enum sections by declared option order before pagination", async () => {
    await location("Room one", "room");
    await location("Room two", "room");
    await location("Box one", "box");

    const grouped = (pageIndex: number, readIntent?: "count") =>
      locationList(
        ctx.db,
        withListGroupBy({ itemTypeFilter: ["box", "room"] }, "type"),
        [
          { orderBy: "name", direction: "asc" },
          { orderBy: "type", direction: "desc" },
        ],
        { pageIndex, pageSize: 1 },
        readIntent,
      );
    const pages = await Promise.all([0, 1, 2].map((index) => grouped(index)));
    expect(pages.map((result) => result.data[0]?.name)).toEqual([
      "Room one",
      "Room two",
      "Box one",
    ]);
    expect(pages.map((result) => result.count)).toEqual([3, 3, 3]);
    expect(groups(pages[0]!)).toEqual([
      { key: "room", label: "room", count: 2 },
      { key: "box", label: "box", count: 1 },
    ]);
    expect(await grouped(0, "count")).toEqual({ data: [], count: 3 });
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

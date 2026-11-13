import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ProductCategoryShortcode } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  ledgerParty,
  product as productTable,
  vendor as vendorTable,
} from "~/server/db/schema";
import { insertPurchaseEventRows } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import {
  createLedgerParty,
  ledgerPartyScaffold,
} from "~/server/domains/ledger-party/repo/ledger-party";
import { locationScaffold } from "~/server/domains/location/repo/crud";
import { createMealWithEntityId } from "~/server/domains/meal/repo/crud";
import { createProductCategory } from "~/server/domains/product-category/repo/product-category";
import { recipeScaffold } from "~/server/domains/recipe/repo/crud";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { withListGroupBy } from "~/server/generic/list/repo/list";
import {
  createInventoryFixture,
  createLocationFixture,
  createPlantFixture,
  createProductFixture,
  createRecipeFixture,
  listProductsFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { groupSql, ListContext } from "./field-compiler";
import { readGroupedQuery } from "./grouped-query";

const ctx = withTestDb();
const groups = (result: {
  groups?: { key: string; label: string; count: number; subtree?: boolean }[];
}) =>
  result.groups?.map((group) => ({
    key: z.array(z.string()).parse(JSON.parse(group.key)).at(-1),
    label: group.label,
    count: group.count,
    subtree: group.subtree,
  }));
// The kernel carries a validated `groupBy` beside the filters, like `nesting`.
const groupedProducts = (
  sort: Parameters<typeof listProductsFixture>[2],
  pageIndex: number,
  pageSize: number,
) =>
  listProductsFixture(
    ctx.db,
    withListGroupBy({}, [{ key: "categoryId" }]),
    sort,
    {
      pageIndex,
      pageSize,
    },
  );
const kernel = () =>
  entityKernelContextSchema.parse(
    createTestRequestContext(ctx.db, {
      auth: { userId: testUserId("test-user-id") },
    }),
  );
async function category(
  name: string,
  sortOrder: number,
  parentId: ProductCategoryShortcode = taxonomyShortcode("tools"),
) {
  return createProductCategory(
    ctx.db,
    {
      spendingCategoryId: null,
      spendingCategoryMode: "inherit",
      name,
      aliases: [],
      description: null,
      parentId,
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
        groupBy: [{ key: "category" }],
        pagination: { pageIndex, pageSize },
      });
    const sections = [
      { key: alpha.output.id, label: "Alpha shelf group", count: 2 },
      { key: beta.output.id, label: "Beta shelf group", count: 1 },
      { key: FILTER_NONE, label: "Unassigned", count: 1 },
    ];
    // A page boundary inside the Alpha section, then one before No category.
    for (const pageSize of [1, 3]) {
      const pages = await Promise.all(
        Array.from({ length: Math.ceil(4 / pageSize) }, (_, index) =>
          read(index, pageSize),
        ),
      );
      for (const page of pages)
        expect(groups(page.meta)).toMatchObject(sections);
      const names = pages.flatMap((page) =>
        page.items.map(
          (item) =>
            z.object({ displayName: z.string() }).parse(item).displayName,
        ),
      );
      expect(names.map((name) => name.split(" · ")[0])).toMatchObject([
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

  it("groups at a hierarchy level: ancestor sections count descendants, a shallower value groups under itself, no value last, contiguous across pages", async () => {
    // Tools (level 1) > Alpha (2) > Alpha leaf (3); Tools > Beta (2).
    const alpha = await category("Alpha level group", 0);
    const alphaLeaf = await category("Alpha leaf group", 0, alpha.output.id);
    const beta = await category("Beta level group", 1);
    const shelf = await location("Level shelf", "box");
    const ids: Awaited<ReturnType<typeof createInventoryFixture>>["id"][] = [];
    // Created out of section order, so only the group-first ORDER BY puts
    // the rows together.
    for (const [name, categoryId] of [
      ["Root one", taxonomyShortcode("tools")],
      ["No category one", null],
      ["Alpha leaf one", alphaLeaf.output.id],
      ["Beta one", beta.output.id],
      ["Alpha direct", alpha.output.id],
    ] as const) {
      const item = await product(name, categoryId);
      const entry = await createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      ids.push(entry.id);
    }
    const read = (
      pageIndex: number,
      pageSize: number,
      filters: {
        categoryFilter?: string[];
        includeSubProductCategories?: boolean;
      } = {},
    ) =>
      executeEntity(kernel(), {
        action: "list",
        entity: "inventory",
        filters: { ids, ...filters },
        sort: [{ orderBy: "product", direction: "asc" }],
        groupBy: [{ key: "category", level: 2 }],
        pagination: { pageIndex, pageSize },
      });
    const sections = [
      {
        key: alpha.output.id,
        label: "Alpha level group",
        count: 2,
        subtree: true,
      },
      {
        key: beta.output.id,
        label: "Beta level group",
        count: 1,
        subtree: false,
      },
      {
        key: taxonomyShortcode("tools"),
        label: "Tools",
        count: 1,
        subtree: false,
      },
      { key: FILTER_NONE, label: "Unassigned", count: 1, subtree: false },
    ];
    const displayNames = (items: readonly unknown[]) =>
      items.map(
        (item) =>
          z
            .object({ displayName: z.string() })
            .parse(item)
            .displayName.split(" · ")[0],
      );
    // Page boundaries inside the Alpha section and before No category.
    for (const pageSize of [1, 2, 4]) {
      const pages = await Promise.all(
        Array.from({ length: Math.ceil(5 / pageSize) }, (_, index) =>
          read(index, pageSize),
        ),
      );
      for (const page of pages)
        expect(groups(page.meta)).toMatchObject(sections);
      expect(pages.flatMap((page) => displayNames(page.items))).toMatchObject([
        "Alpha direct",
        "Alpha leaf one",
        "Beta one",
        "Root one",
        "No category one",
      ]);
    }
    // A header filters to its key, with descendants exactly when its section
    // holds them, so the filtered list is that one section.
    for (const section of sections.slice(0, 3)) {
      const filtered = await read(0, 10, {
        categoryFilter: [section.key],
        includeSubProductCategories: section.subtree,
      });
      expect(groups(filtered.meta)).toMatchObject([section]);
      expect(filtered.meta.totalCount).toBe(section.count);
    }
  });

  it("rejects ancestor levels on values and beyond the declared hierarchy", async () => {
    for (const dimension of [
      { key: "placement", level: 1 },
      { key: "category", level: 4 },
    ])
      await expect(
        executeEntity(kernel(), {
          action: "list",
          entity: "inventory",
          filters: {},
          groupBy: [dimension],
          pagination: { pageIndex: 0, pageSize: 1 },
        }),
      ).rejects.toThrow("Cannot group inventory");
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
    expect(groups(pages[0]!)).toMatchObject([
      { key: alpha.output.id, count: 1, label: "Alpha group" },
      { key: beta.output.id, count: 1, label: "Beta group" },
      { key: FILTER_NONE, label: "Unassigned", count: 1 },
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
    expect(groups(result)?.map((group) => group.key)).toMatchObject([
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
      groupBy: [{ key: "categoryId" }],
      pagination: { pageIndex: 0, pageSize: 1 },
    });
    expect(groups(grouped.meta)).toEqual(groups(pages[0]!));
    const restricted = await executeEntity(kernelContext, {
      action: "list",
      entity: "product",
      filters: { ids: [betaProduct.id] },
      groupBy: [{ key: "categoryId" }],
      pagination: { pageIndex: 0, pageSize: 1 },
    });
    expect(groups(restricted.meta)).toMatchObject([
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

  it("orders scalar sections before pagination and keeps count links separate from predicate groups", async () => {
    await location("Room one", "room");
    await location("Room two", "room");
    await location("Box one", "box");

    const grouped = (pageIndex: number, readIntent?: "count") =>
      locationScaffold.read(ctx.db, {
        filters: withListGroupBy({ itemTypeFilter: ["box", "room"] }, [
          { key: "type" },
        ]),
        sorts: [
          { orderBy: "name", direction: "asc" },
          { orderBy: "type", direction: "desc" },
        ],
        pagination: { pageIndex, pageSize: 1 },
        readIntent: readIntent,
      });
    const pages = await Promise.all([0, 1, 2].map((index) => grouped(index)));
    expect(pages.map((result) => result.data[0]?.name)).toEqual([
      "Room one",
      "Room two",
      "Box one",
    ]);
    expect(pages.map((result) => result.count)).toEqual([3, 3, 3]);
    expect(groups(pages[0]!)).toMatchObject([
      { key: "room", label: "room", count: 2 },
      { key: "box", label: "box", count: 1 },
    ]);
    expect(await grouped(0, "count")).toEqual({
      data: [],
      count: 3,
      hasNextPage: true,
      unresolvedCount: undefined,
    });
    const planned = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Planned soup" }),
      ctx.actor,
    );
    const unplanned = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Unplanned soup" }),
      ctx.actor,
    );
    await createMealWithEntityId(
      ctx.db,
      {
        date: "2026-09-10",
        name: "Soup supper",
        recipes: [{ recipeId: planned.id, scale: 1 }],
      },
      ctx.actor,
    );
    const recipes = await recipeScaffold.read(ctx.db, {
      filters: withListGroupBy({}, [{ key: "meals" }]),
      sorts: [],
      projection: ["id", "meals"],
      pagination: { pageIndex: 0, pageSize: 50 },
    });
    expect(groups(recipes)).toMatchObject([
      { key: "false", count: 1 },
      { key: "true", count: 1 },
    ]);
    expect(
      recipes.data.map((item) => z.object({ meals: z.number() }).parse(item)),
    ).toEqual([{ meals: 0 }, { meals: 1 }]);
    for (const [presence, id] of [
      ["has", planned.id],
      ["none", unplanned.id],
    ] as const) {
      const filtered = await executeEntity(kernel(), {
        action: "list",
        entity: "recipe",
        filters: { mealPresenceFilter: presence },
      });
      expect(filtered.items.map((item) => item.id)).toEqual([id]);
    }
    const flags = await Promise.all(
      [null, false, true].map((usdaUnavailable) =>
        createProductFixture(
          ctx.db,
          makeProductInput({
            name: `Nullable flag ${usdaUnavailable}`,
            usdaUnavailable,
          }),
          ctx.actor,
        ),
      ),
    );
    for (const [filters, expected] of [
      [{ usdaUnavailable: false }, [flags[1]!.id]],
      [{ usdaUnavailable: true }, [flags[2]!.id]],
      [{ usdaUnavailablePresenceFilter: "none" }, [flags[0]!.id]],
      [{ usdaUnavailablePresenceFilter: "has" }, [flags[1]!.id, flags[2]!.id]],
      [
        { usdaUnavailable: false, usdaUnavailablePresenceFilter: "none" },
        [flags[0]!.id, flags[1]!.id],
      ],
    ] as const) {
      const page = await executeEntity(kernel(), {
        action: "list",
        entity: "product",
        filters: { ids: flags.map(({ id }) => id), ...filters },
        groupBy: [{ key: "usdaUnavailable" }],
      });
      expect(page.items.map((item) => item.id).sort()).toEqual(
        [...expected].sort(),
      );
    }
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

    const result = await ledgerPartyScaffold.read(ctx.db, {
      filters: {},
      sorts: [
        { orderBy: "kind", direction: "asc" },
        { orderBy: "name", direction: "desc" },
        { orderBy: "createdAt", direction: "desc" },
      ],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
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

// Memberships must be paginated before hydration: overlaps must never consume
// canonical row slots, duplicate a row within a path, or corrupt prefix totals.
describe("expanded grouped list memberships", () => {
  it("pages distinct text-array memberships and keeps full distinct prefix counts", async () => {
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Membership alpha",
        tags: ["A", "A", "B"],
        kind: "durable",
      }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Membership beta",
        tags: [],
        kind: "durable",
      }),
      ctx.actor,
    );
    const projectRoot = await createRepoEntity(ctx, "project", {
      name: "Grouping project root",
    });
    const allocationProject = await createRepoEntity(ctx, "project", {
      name: "Grouping allocation project",
      parentProjectId: projectRoot.output.id,
    });
    const basis = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Grouping basis",
        productId: first.id,
        projectId: allocationProject.output.id,
        cost: 10,
        date: "2026-01-01",
      }),
    );
    const noProject = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Grouping unallocated expense",
        cost: 4,
        date: "2026-01-01",
      }),
    );
    const byAllocatedProject = await executeEntity(kernel(), {
      action: "list",
      entity: "expense",
      filters: { ids: [basis.output.id, noProject.output.id] },
      groupBy: [{ key: "projectFilter" }],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    if (byAllocatedProject.action !== "list") throw new Error("expected list");
    // Grouping must request the allocation dimension even without a Project
    // filter. Otherwise its prepared row set would expose only NULL values.
    expect(groups(byAllocatedProject.meta)).toMatchObject([
      {
        key: allocationProject.output.id,
        label: "Grouping allocation project",
        count: 1,
      },
      { key: FILTER_NONE, count: 1 },
    ]);
    expect(byAllocatedProject.meta.totalCount).toBe(2);
    const projectGroups = await executeEntity(kernel(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, second.id] },
      groupBy: [{ key: "related:product.projects", level: 1 }],
    });
    if (projectGroups.action !== "list") throw new Error("expected list");
    expect(groups(projectGroups.meta)).toMatchObject([
      { key: projectRoot.output.id, count: 1, subtree: true },
      { key: FILTER_NONE, count: 1 },
    ]);
    for (const includeDescendants of [undefined, false, true]) {
      const drilled = await executeEntity(kernel(), {
        action: "list",
        entity: "product",
        filters: {
          ids: [first.id, second.id],
          projectId: [projectRoot.output.id],
          projectIdIncludeDescendants: includeDescendants,
        },
      });
      if (drilled.action !== "list") throw new Error("expected list");
      expect(drilled.items.map((row) => row.id)).toEqual(
        includeDescendants ? [first.id] : [],
      );
    }
    const knownParty = await createRepoEntity(ctx, "ledgerParty", {
      name: "Grouping known party",
    });
    await insertPurchaseEventRows(ctx.db, "ExpenseAttribution", [
      {
        expenseId: basis.entityId,
        role: "funder",
        ledgerPartyId: knownParty.entityId,
        weight: 1,
      },
      {
        expenseId: basis.entityId,
        role: "beneficiary",
        ledgerPartyId: null,
        weight: 1,
      },
    ]);
    const byParty = await executeEntity(kernel(), {
      action: "list",
      entity: "expense",
      filters: { ids: [basis.output.id] },
      groupBy: [{ key: "ledgerPartyId" }],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    if (byParty.action !== "list") throw new Error("expected list");
    expect(groups(byParty.meta)).toMatchObject([
      { key: knownParty.output.id, count: 1 },
      { key: FILTER_NONE, count: 1 },
    ]);
    expect(byParty.meta.membershipCount).toBe(2);
    const complete = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Grouping fully attributed expense",
        cost: 2,
        date: "2026-01-01",
      }),
    );
    await insertPurchaseEventRows(ctx.db, "ExpenseAttribution", {
      expenseId: complete.entityId,
      role: "funder",
      ledgerPartyId: knownParty.entityId,
      weight: 1,
    });
    const ids = [basis.output.id, noProject.output.id, complete.output.id];
    for (const [filters, expected] of [
      [
        { ledgerPartyIdPresenceFilter: "none" },
        [basis.output.id, noProject.output.id],
      ],
      [
        { ledgerPartyIdPresenceFilter: "has" },
        [basis.output.id, complete.output.id],
      ],
      [{ ledgerPartyIdExclude: [FILTER_NONE] }, [complete.output.id]],
      [
        {
          ledgerPartyId: [knownParty.output.id],
          ledgerPartyIdExclude: [FILTER_NONE],
        },
        [complete.output.id],
      ],
      [
        {
          ledgerPartyIdPresenceFilter: "none",
          ledgerPartyIdExclude: [FILTER_NONE],
        },
        [],
      ],
      [{ ledgerPartyIdExclude: [knownParty.output.id, FILTER_NONE] }, []],
    ] as const) {
      const filtered = await executeEntity(kernel(), {
        action: "list",
        entity: "expense",
        filters: { ids, ...filters },
        groupBy: [{ key: "ledgerPartyId" }],
      });
      expect(filtered.items.map((item) => item.id).sort()).toEqual(
        [...expected].sort(),
      );
      expect(
        filtered.meta.memberships?.some((membership) =>
          membership.path.includes(FILTER_NONE),
        ) ?? false,
      ).toBe(!("ledgerPartyIdExclude" in filters));
    }
    const padded = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Tagged grouping box", tags: [" A ", "A"] }),
      ctx.actor,
    );
    const blank = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Blank-tag grouping box", tags: [" \t "] }),
      ctx.actor,
    );
    for (const [filters, expected] of [
      [{ tagFilters: ["A"] }, [padded.id]],
      [{ tagsPresenceFilter: "none" }, [blank.id]],
      [{ tagsExclude: [FILTER_NONE] }, [padded.id]],
      [{ tagsExclude: ["A"] }, [blank.id]],
    ] as const) {
      const page = await executeEntity(kernel(), {
        action: "list",
        entity: "location",
        filters: { ids: [padded.id, blank.id], ...filters },
        groupBy: [{ key: "tags" }],
      });
      expect(page.items.map((item) => item.id)).toEqual(expected);
      expect(page.meta.membershipCount).toBe(1);
    }
    const pages = [];
    for (const pageIndex of [0, 1, 2]) {
      const page = await executeEntity(kernel(), {
        action: "list",
        entity: "product",
        filters: { ids: [first.id, second.id] },
        groupBy: [{ key: "kind" }, { key: "tags" }],
        sort: [{ orderBy: "name", direction: "asc" }],
        pagination: { pageIndex, pageSize: 1 },
      });
      if (page.action !== "list") throw new Error("expected list");
      expect(page.items).toHaveLength(1);
      expect(page.meta.totalCount).toBe(2);
      expect(page.meta.membershipCount).toBe(3);
      expect(page.meta.memberships).toHaveLength(1);
      expect(page.meta.groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: JSON.stringify(["durable"]),
            path: ["durable"],
            count: 2,
            parentCount: 2,
            metrics: expect.objectContaining({
              expenseTotal: {
                sum: 10,
                presentCount: 1,
                totalCount: 1,
                coverage: 1,
              },
            }),
          }),
          expect.objectContaining({
            path: ["durable", "A"],
            count: 1,
            parentCount: 2,
            overlapping: true,
          }),
          expect.objectContaining({ path: ["durable", FILTER_NONE], count: 1 }),
        ]),
      );
      pages.push(...(page.meta.memberships ?? []));
    }
    expect(pages).toEqual([
      { id: first.id, path: ["durable", "A"] },
      { id: first.id, path: ["durable", "B"] },
      { id: second.id, path: ["durable", FILTER_NONE] },
    ]);
    // A summary-only read (page size 0) keeps grouping and returns no rows.
    // With the multi-valued dimension first, the column margin counts the
    // record holding A and B once, where summing the column's cells gives 3.
    const summary = await executeEntity(kernel(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, second.id] },
      groupBy: [{ key: "tags" }, { key: "kind" }],
      pagination: { pageIndex: 0, pageSize: 0 },
    });
    if (summary.action !== "list") throw new Error("expected list");
    expect(summary.items).toEqual([]);
    expect(summary.meta).toMatchObject({
      pageSize: 0,
      hasNextPage: false,
      totalCount: 2,
    });
    expect(
      summary.meta.groups?.filter(({ path }) => path.length === 2),
    ).toHaveLength(3);
    expect(summary.meta.margins).toMatchObject([
      { dimensions: [1], path: ["durable"], count: 2 },
    ]);
  });

  it("expands multiple references in SQL and preserves unassigned records", async () => {
    const plant = await createPlantFixture(
      ctx.db,
      { name: "Grouping herb" },
      ctx.actor,
    );
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Reference memberships",
        growsPlantId: plant.id,
      }),
      ctx.actor,
    );
    const unassigned = await product("Unassigned reference", null);
    const alpha = await location("Reference alpha", "box");
    const beta = await location("Reference beta", "box");
    for (const place of [alpha, beta])
      await createInventoryFixture(
        ctx.db,
        {
          productId: first.id,
          locationId: place.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    const result = await executeEntity(kernel(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, unassigned.id] },
      groupBy: [{ key: "stockLocation" }],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    if (result.action !== "list") throw new Error("expected list");
    expect(result.items).toHaveLength(2);
    expect(result.meta.totalCount).toBe(2);
    expect(result.meta.membershipCount).toBe(3);
    expect(result.meta.memberships).toEqual([
      { id: first.id, path: [alpha.id] },
      { id: first.id, path: [beta.id] },
      { id: unassigned.id, path: [FILTER_NONE] },
    ]);
    // Computed public titles use the canonical repository label, not a new
    // stored-title requirement or the root Product's label.
    const byPlant = await executeEntity(kernel(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, unassigned.id] },
      groupBy: [{ key: "growsPlant" }],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    if (byPlant.action !== "list") throw new Error("expected list");
    expect(groups(byPlant.meta)).toMatchObject([
      { key: plant.id, label: "Grouping herb", count: 1 },
      { key: FILTER_NONE, count: 1 },
    ]);
    const counterparties = await Promise.all(
      ["Reference vendor alpha", "Reference vendor beta"].map((name) =>
        createRepoEntity(ctx, "vendor", { name }),
      ),
    );
    const purchases: string[] = [];
    for (const counterparty of counterparties) {
      const purchase = await createRepoEntity(ctx, "purchase", {
        vendorId: counterparty.output.id,
        date: "2026-01-01",
      });
      purchases.push(purchase.output.id);
      // Repeated lines and signed refunds preserve one membership per Vendor.
      for (const cost of [10, 3, -2])
        await createRepoEntity(
          ctx,
          "expense",
          makeExpenseInput({
            name: "Reference purchase line",
            productId: first.id,
            purchaseId: purchase.output.id,
            cost,
            date: "2026-01-01",
          }),
        );
    }
    const paths = [];
    for (const pageIndex of [0, 1, 2]) {
      const byVendor = await executeEntity(kernel(), {
        action: "list",
        entity: "product",
        filters: { ids: [first.id, unassigned.id] },
        groupBy: [{ key: "related:product.vendors" }],
        pagination: { pageIndex, pageSize: 1 },
      });
      if (byVendor.action !== "list") throw new Error("expected list");
      expect(byVendor.meta.totalCount).toBe(2);
      expect(byVendor.meta.membershipCount).toBe(3);
      paths.push(...(byVendor.meta.memberships ?? []));
    }
    expect(paths).toEqual([
      ...counterparties.map((counterparty) => ({
        id: first.id,
        path: [counterparty.output.id],
      })),
      { id: unassigned.id, path: [FILTER_NONE] },
    ]);
    const filtered = await executeEntity(kernel(), {
      action: "list",
      entity: "product",
      filters: {
        ids: [first.id, unassigned.id],
        vendorId: [counterparties[0]!.output.id],
      },
      groupBy: [{ key: "related:product.vendors" }],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    if (filtered.action !== "list") throw new Error("expected list");
    expect(filtered.meta.totalCount).toBe(1);
    expect(filtered.meta.memberships).toEqual(paths.slice(0, 2));
    // Historical references retain their source FK after a target is deleted.
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ deletedAt: new Date("2026-01-02T00:00:00Z") })
      .where(eq(vendorTable.id, counterparties[0]!.entityId));
    for (const [filters, expected] of [
      [{ vendorIdPresenceFilter: "none" }, [purchases[0]]],
      [{ vendorIdExclude: [FILTER_NONE] }, [purchases[1]]],
    ] as const) {
      const page = await executeEntity(kernel(), {
        action: "list",
        entity: "purchase",
        filters: { ids: purchases, ...filters },
        groupBy: [{ key: "vendorId" }],
      });
      expect(page.items.map((item) => item.id)).toEqual(expected);
    }
  });

  it("rejects duplicate dimensions, excess dimensions, and buckets on non-dates", async () => {
    for (const groupBy of [
      [{ key: "kind" }, { key: "kind" }],
      ["kind", "tags", "categoryId", "stockTracked"].map((key) => ({ key })),
      [{ key: "kind", bucket: "month" as const }],
    ]) {
      await expect(
        executeEntity(kernel(), {
          action: "list",
          entity: "product",
          filters: {},
          groupBy,
        }),
      ).rejects.toThrow(/groupBy|Cannot group/);
    }
  });
});

// Missing scalar values are unknown contributors; an observed zero remains
// present. Metrics deduplicate a canonical record before every prefix sum.
describe("grouped SQL metric coverage and calendar boundaries", () => {
  it("keeps unknown sums null and counts an observed zero in coverage", async () => {
    const known = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Known observation", stockTracked: true }),
      ctx.actor,
    );
    const unknown = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unknown observation", stockTracked: false }),
      ctx.actor,
    );
    const group = groupSql(
      "product",
      { key: "stockTracked" },
      {},
      productTable,
      ListContext.empty,
    );
    const result = await readGroupedQuery({
      db: ctx.db,
      source: productTable,
      id: sql`${productTable.id}`,
      code: sql`${productTable.shortcode}`,
      where: inArray(productTable.shortcode, [known.id, unknown.id]),
      groups: [group],
      metrics: [
        {
          key: "observed",
          value: sql`CASE WHEN ${productTable.stockTracked} THEN 0 ELSE null END`,
        },
      ],
      order: [sql`${group.key} asc nulls last`, sql`${productTable.id} asc`],
      limit: 1,
      offset: 0,
    });
    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["true"],
          metrics: {
            observed: { sum: 0, presentCount: 1, totalCount: 1, coverage: 1 },
          },
        }),
        expect.objectContaining({
          path: ["false"],
          metrics: {
            observed: {
              sum: null,
              presentCount: 0,
              totalCount: 1,
              coverage: 0,
            },
          },
        }),
      ]),
    );
  });

  it("uses household-local timestamp days before month/week/quarter/year bucketing", async () => {
    const item = await product("Calendar edge", null);
    await getDb(ctx.db)
      .update(productTable)
      .set({ createdAt: new Date("2026-04-01T00:30:00.000Z") })
      .where(eq(productTable.shortcode, item.id));
    for (const [bucket, day, end] of [
      ["day", "2026-03-31", "2026-03-31"],
      ["week", "2026-03-30", "2026-04-05"],
      ["month", "2026-03-01", "2026-03-31"],
      ["quarter", "2026-01-01", "2026-03-31"],
      ["year", "2026-01-01", "2026-12-31"],
    ] as const) {
      const result = await executeEntity(kernel(), {
        action: "list",
        entity: "product",
        filters: { ids: [item.id] },
        groupBy: [{ key: "createdAt", bucket }],
      });
      if (result.action !== "list") throw new Error("expected list");
      expect(result.meta.memberships).toEqual([{ id: item.id, path: [day] }]);
      const drilled = await executeEntity(kernel(), {
        action: "list",
        entity: "product",
        filters: { ids: [item.id], createdFrom: day, createdTo: end },
      });
      if (drilled.action !== "list") throw new Error("expected list");
      expect(drilled.items.map((row) => row.id)).toEqual([item.id]);
    }
    const nextMonth = await executeEntity(kernel(), {
      action: "list",
      entity: "product",
      filters: {
        ids: [item.id],
        createdFrom: "2026-04-01",
        createdTo: "2026-04-30",
      },
    });
    if (nextMonth.action !== "list") throw new Error("expected list");
    expect(nextMonth.items).toEqual([]);
  });
});

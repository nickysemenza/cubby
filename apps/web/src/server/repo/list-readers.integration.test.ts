/**
 * Order, paging and totals of the list readers with their own row query,
 * ordering or hydration (Ingredient's alias-sensitive count sorts, the
 * Location and Product pickers, Inventory's joined row query, and the
 * Inventory and Project full-filter sums). Each reader
 * builds its ordering before pagination, so a page boundary must continue
 * the same sequence and the total must count the whole filtered set.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { ingredientList } from "./ingredient/search";
import { inventoryentryList } from "./inventory/crud";
import { locationSearch } from "./location/crud";
import { productSearch } from "./product/crud";
import { projectListRead } from "./project/lookup";
import {
  createIngredientFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";

const page = (pageIndex: number, pageSize = 2) => ({ pageIndex, pageSize });

/**
 * Every two-row page of a read, concatenated. Fixtures that tie on every
 * requested sort key straddle these page boundaries, so only a deterministic
 * fallback order keeps each row on exactly one page.
 */
const readPages = async <T>(
  read: (pageIndex: number) => Promise<{ data: T[]; count: number }>,
) => {
  const rows: T[] = [];
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const result = await read(pageIndex);
    rows.push(...result.data);
    if (result.data.length === 0 || rows.length >= result.count) break;
  }
  return rows;
};
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("custom list readers", () => {
  const ctx = withTestDb();

  it("pages Ingredients by a linked-product count sort and reports the filtered total", async () => {
    const [alpha, beta, gamma] = await Promise.all(
      ["Sortcase alpha", "Sortcase beta", "Sortcase gamma"].map((name) =>
        createIngredientFixture(ctx.db, { name, aliases: [] }, ctx.actor),
      ),
    );
    for (const [ingredient, count] of [
      [alpha!, 2],
      [gamma!, 1],
    ] as const)
      for (let index = 0; index < count; index++)
        await createProductFixture(
          ctx.db,
          makeProductInput({
            name: `${ingredient.name} product ${index}`,
            ingredientId: ingredient.id,
          }),
          ctx.actor,
        );

    const filters = { nameFilter: "Sortcase" };
    const sorts = [{ orderBy: "product", direction: "desc" as const }];
    const pages = await Promise.all(
      [0, 1].map((index) =>
        ingredientList(ctx.db, filters, sorts, page(index)),
      ),
    );
    expect(pages.map((result) => result.data.map((row) => row.id))).toEqual([
      [alpha!.id, gamma!.id],
      [beta!.id],
    ]);
    expect(pages.map((result) => result.count)).toEqual([3, 3]);

    expect(
      await ingredientList(ctx.db, filters, sorts, page(0), "count"),
    ).toEqual({ data: [], count: 3 });
    const ids = await Promise.all(
      [0, 1].map((index) =>
        ingredientList(ctx.db, filters, sorts, page(index), "ids"),
      ),
    );
    expect(ids).toEqual([
      { data: [{ id: alpha!.id }, { id: gamma!.id }], hasMore: true },
      { data: [{ id: beta!.id }], hasMore: false },
    ]);

    // Four rows tie on both requested sorts, so the shortcode decides.
    const [lead, ...tied] = await Promise.all(
      ["one", "two", "three", "four", "five"].map((suffix) =>
        createIngredientFixture(
          ctx.db,
          { name: `Tiecase ${suffix}`, aliases: [] },
          ctx.actor,
        ),
      ),
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Tiecase lead product",
        ingredientId: lead!.id,
      }),
      ctx.actor,
    );
    const tieFilters = { nameFilter: "Tiecase" };
    const tieSorts = [
      { orderBy: "product", direction: "desc" as const },
      { orderBy: "appearsInRecipes", direction: "desc" as const },
    ];
    const expected = [lead!.id, ...tied.map((row) => row.id).sort(byText)];
    expect(
      (
        await readPages((index) =>
          ingredientList(ctx.db, tieFilters, tieSorts, page(index)),
        )
      ).map((row) => row.id),
    ).toEqual(expected);
    const idPages = await Promise.all(
      [0, 1, 2].map((index) =>
        ingredientList(ctx.db, tieFilters, tieSorts, page(index), "ids"),
      ),
    );
    expect(
      idPages.flatMap((result) => result.data.map((row) => row.id)),
    ).toEqual(expected);
  });

  it("pages the Location picker by its own sort roster", async () => {
    for (const name of ["Shelf alpha", "Shelf beta", "Shelf gamma"])
      await createLocationFixture(
        ctx.db,
        makeLocationInput({ name, type: "box" }),
        ctx.actor,
      );
    await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Other room", type: "room" }),
      ctx.actor,
    );

    const pages = await Promise.all(
      [0, 1].map((index) =>
        locationSearch(
          ctx.db,
          { nameFilter: "Shelf" },
          [{ orderBy: "name", direction: "desc" }],
          page(index),
        ),
      ),
    );
    expect(pages.map((result) => result.data.map((row) => row.name))).toEqual([
      ["Shelf gamma", "Shelf beta"],
      ["Shelf alpha"],
    ]);
    expect(pages.map((result) => result.count)).toEqual([3, 3]);

    // Five rows tie on the requested type, so the private id decides.
    const tied = [];
    for (const suffix of ["one", "two", "three", "four", "five"])
      tied.push(
        await createLocationFixture(
          ctx.db,
          makeLocationInput({ name: `Tiebox ${suffix}`, type: "box" }),
          ctx.actor,
        ),
      );
    const byId = new Map(tied.map((row) => [row.id, row.entityId]));
    expect(
      (
        await readPages((index) =>
          locationSearch(
            ctx.db,
            { nameFilter: "Tiebox" },
            [{ orderBy: "type", direction: "asc" }],
            page(index),
          ),
        )
      ).map((row) => row.id),
    ).toEqual(
      tied
        .map((row) => row.id)
        .sort((a, b) => byText(byId.get(a)!, byId.get(b)!)),
    );
  });

  it("pages the Product picker and matches names through aliases", async () => {
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Picker alpha" }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Zeta widget", aliases: ["picker gamma"] }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Picker beta" }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unrelated item" }),
      ctx.actor,
    );

    const pages = await Promise.all(
      [0, 1].map((index) =>
        productSearch(
          ctx.db,
          { nameFilter: "picker" },
          [{ orderBy: "name", direction: "desc" }],
          page(index),
        ),
      ),
    );
    expect(pages.map((result) => result.data.map((row) => row.name))).toEqual([
      ["Zeta widget", "Picker beta"],
      ["Picker alpha"],
    ]);
    expect(pages.map((result) => result.count)).toEqual([3, 3]);

    // Five rows tie on manufacturer and model, so the name decides.
    for (const suffix of ["e", "c", "a", "d", "b"])
      await createProductFixture(
        ctx.db,
        makeProductInput({ name: `Tiepick ${suffix}` }),
        ctx.actor,
      );
    expect(
      (
        await readPages((index) =>
          productSearch(
            ctx.db,
            { nameFilter: "Tiepick" },
            [
              { orderBy: "manufacturer", direction: "asc" },
              { orderBy: "model", direction: "asc" },
            ],
            page(index),
          ),
        )
      ).map((row) => row.name),
    ).toEqual(["a", "b", "c", "d", "e"].map((suffix) => `Tiepick ${suffix}`));
  });

  it("pages Inventory by a joined-product sort and totals the whole filtered set", async () => {
    for (const [name, price] of [
      ["Stockcase gamma", 30],
      ["Stockcase alpha", 10],
      ["Stockcase beta", 20],
      ["Elsewhere stock", 1000],
    ] as const) {
      const sku = await createProductFixture(
        ctx.db,
        makeProductInput({ name, price }),
        ctx.actor,
      );
      const shelf = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `${name} shelf`, type: "box" }),
        ctx.actor,
      );
      await createInventoryFixture(
        ctx.db,
        {
          productId: sku.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    }

    const read = (pageIndex: number, readIntent?: "count") =>
      inventoryentryList(
        ctx.db,
        { productNameFilter: "Stockcase" },
        [{ orderBy: "product", direction: "asc" }],
        page(pageIndex),
        readIntent,
      );
    const pages = await Promise.all([read(0), read(1)]);
    expect(
      pages.map((result) => result.data.map((row) => row.displayName)),
    ).toEqual([
      [
        expect.stringContaining("Stockcase alpha"),
        expect.stringContaining("Stockcase beta"),
      ],
      [expect.stringContaining("Stockcase gamma")],
    ]);
    expect(pages).toMatchObject([
      { count: 3, sums: { valuation: 60 } },
      { count: 3, sums: { valuation: 60 } },
    ]);
    expect(await read(0, "count")).toEqual({
      data: [],
      count: 3,
      sums: undefined,
    });

    // Five entries of one product tie on product and amount, so the
    // creation-time and id fallback decides; paging must match one read.
    const sku = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Tiestock item", price: 1 }),
      ctx.actor,
    );
    const tied = [];
    for (const suffix of ["one", "two", "three", "four", "five"]) {
      const shelf = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `Tiestock ${suffix}`, type: "box" }),
        ctx.actor,
      );
      tied.push(
        await createInventoryFixture(
          ctx.db,
          {
            productId: sku.id,
            locationId: shelf.id,
            amount: { value: 1, unit: "each" },
          },
          ctx.actor,
        ),
      );
    }
    const tieRead = (pagination: { pageIndex: number; pageSize: number }) =>
      inventoryentryList(
        ctx.db,
        { productNameFilter: "Tiestock" },
        [
          { orderBy: "product", direction: "asc" },
          { orderBy: "amount", direction: "asc" },
        ],
        pagination,
      );
    const paged = (await readPages((index) => tieRead(page(index)))).map(
      (row) => row.id,
    );
    expect(paged).toEqual(
      (await tieRead(page(0, 100))).data.map((row) => row.id),
    );
    expect([...paged].sort(byText)).toEqual(
      tied.map((row) => row.id).sort(byText),
    );
  });

  it("pages Projects and sums the cost estimate over the whole filtered set", async () => {
    for (const [name, costEstimate] of [
      ["Paging alpha", 10],
      ["Paging beta", 20],
      ["Paging gamma", 30],
      ["Elsewhere", 1000],
    ] as const)
      await insertWithShortcode(ctx.db, "project", { name, costEstimate });

    const read = (pageIndex: number, readIntent?: "count") =>
      projectListRead(
        ctx.db,
        { search: "Paging" },
        [{ orderBy: "name", direction: "asc" }],
        page(pageIndex),
        { kind: "full" },
        readIntent,
      );
    const pages = await Promise.all([read(0), read(1)]);
    expect(pages.map((result) => result.data.map((row) => row.name))).toEqual([
      ["Paging alpha", "Paging beta"],
      ["Paging gamma"],
    ]);
    expect(pages).toMatchObject([
      { count: 3, sums: { costEstimate: 60 } },
      { count: 3, sums: { costEstimate: 60 } },
    ]);
    expect(await read(0, "count")).toEqual({ data: [], count: 3 });

    // Four rows tie on cost and status, so the shortcode decides.
    const lead = await insertWithShortcode(ctx.db, "project", {
      name: "Tieproj lead",
      costEstimate: 50,
    });
    const tied = [];
    for (const suffix of ["one", "two", "three", "four"])
      tied.push(
        await insertWithShortcode(ctx.db, "project", {
          name: `Tieproj ${suffix}`,
          costEstimate: 20,
        }),
      );
    expect(
      (
        await readPages((index) =>
          projectListRead(
            ctx.db,
            { search: "Tieproj" },
            [
              { orderBy: "costEstimate", direction: "desc" },
              { orderBy: "status", direction: "asc" },
            ],
            page(index),
            { kind: "full" },
          ),
        )
      ).map((row) => row.id),
    ).toEqual([
      lead.shortcode,
      ...tied.map((row) => row.shortcode).sort(byText),
    ]);
  });
});

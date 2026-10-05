/**
 * Order, paging and totals of the list readers with their own row query,
 * ordering or hydration (Ingredient's alias-sensitive count sorts, the
 * Location and Product pickers, and Project's full-filter sums). Each reader
 * builds its ordering before pagination, so a page boundary must continue
 * the same sequence and the total must count the whole filtered set.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { ingredientList } from "./ingredient/search";
import { locationSearch } from "./location/crud";
import { productSearch } from "./product/crud";
import { projectListRead } from "./project/lookup";
import {
  createIngredientFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";

const page = (pageIndex: number, pageSize = 2) => ({ pageIndex, pageSize });

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
    expect(pages.map((result) => [result.count, result.sums])).toEqual([
      [3, { costEstimate: 60 }],
      [3, { costEstimate: 60 }],
    ]);
    expect(await read(0, "count")).toEqual({ data: [], count: 3 });
  });
});

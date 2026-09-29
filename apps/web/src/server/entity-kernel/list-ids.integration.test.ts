import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import {
  createInventoryFixture,
  createLocationFixture,
  makeLocationInput,
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * `filters.ids` restricts a kernel list to named rows. Failure modes: the
 * restriction pages the whole repository to find a handful of rows (the
 * statement count grows with the table), or it drops the requested order,
 * paging or casing rules.
 */
describe("kernel list restricted to ids", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  const listIds = (ids: string[], pageIndex = 0) =>
    executeEntity(context(), {
      action: "list",
      entity: "ingredient",
      filters: { ids },
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex, pageSize: 1 },
    });

  it("reads only the named rows, in list order, however large the table", async () => {
    const wanted = await Promise.all(
      ["Ids alpha", "Ids beta"].map((name) =>
        findOrCreateIngredient(ctx.db, name),
      ),
    );
    const codes = wanted.map((row) => row.shortcode);
    const small = await countTestDbQueries(() => listIds(codes));

    for (let index = 0; index < 120; index += 1)
      await findOrCreateIngredient(ctx.db, `Ids filler ${index}`);
    const large = await countTestDbQueries(() => listIds(codes));
    const second = await listIds(
      codes.map((code) => code.toLowerCase()),
      1,
    );

    for (const result of [small.result, large.result, second]) {
      if (result.action !== "list") throw new Error("expected list");
      expect(result.meta.totalCount).toBe(2);
    }
    if (large.result.action !== "list" || second.action !== "list")
      throw new Error("expected list");
    expect(large.result.items.map((row) => row.name)).toEqual(["Ids alpha"]);
    expect(second.items.map((row) => row.name)).toEqual(["Ids beta"]);
    expect(large.queryCount).toBe(small.queryCount);
  });

  it("preserves full-intersection totals on every requested page", async () => {
    const wanted = await Promise.all(
      [10, 20].map((price, index) =>
        createProductFixture(
          ctx.db,
          makeProductInput({ name: `Totals item ${index}`, price }),
          ctx.actor,
        ),
      ),
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unselected item", price: 999 }),
      ctx.actor,
    );
    for (const pageIndex of [0, 1]) {
      const result = await executeEntity(context(), {
        action: "list",
        entity: "product",
        filters: { ids: wanted.map((row) => row.id.toLowerCase()) },
        sort: { orderBy: "name", direction: "asc" },
        pagination: { pageIndex, pageSize: 1 },
      });
      if (result.action !== "list") throw new Error("expected list");
      expect(result.items).toHaveLength(1);
      expect(result.meta.totalCount).toBe(2);
      expect(result.meta.sums).toMatchObject({ price: 30, expenseTotal: 0 });
    }
  });
  it("intersects hand-built inventory predicates before pagination and valuation totals", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Ids stock", price: 10 }),
      ctx.actor,
    );
    const entries = [];
    for (const value of [1, 2, 99]) {
      const shelf = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `Ids shelf ${value}`, type: "shelf" }),
        ctx.actor,
      );
      entries.push(
        await createInventoryFixture(
          ctx.db,
          {
            productId: item.id,
            locationId: shelf.id,
            amount: { value, unit: "each" },
          },
          ctx.actor,
        ),
      );
    }
    for (const pageIndex of [0, 1]) {
      const result = await executeEntity(context(), {
        action: "list",
        entity: "inventory",
        filters: {
          ids: entries.slice(0, 2).map((row) => row.id.toLowerCase()),
          productId: [item.id],
        },
        sort: { orderBy: "amount", direction: "asc" },
        pagination: { pageIndex, pageSize: 1 },
      });
      if (result.action !== "list") throw new Error("expected list");
      expect(result.items).toHaveLength(1);
      expect(result.meta.totalCount).toBe(2);
      expect(result.meta.sums).toMatchObject({ valuation: 30 });
    }
  });
});

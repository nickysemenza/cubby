import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createExpense } from "~/server/repo/expense";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { getProductMovementTimeline } from "./movement-timeline";

/**
 * The product timeline pages the products that moved in the window's order
 * (newest first by latest movement, oldest first by first movement) then id;
 * a page boundary that drifted with the name sort or ignored the order, or a
 * count taken over the page instead of the scope, would still typecheck.
 */
describe("product movement timeline paging", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const make = async (name: string, dates: readonly string[]) => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ name: `Paged timeline ${name}` }),
        ctx.actor,
      );
      for (const date of dates)
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: `Bought ${name}`,
            productId: product.id,
            productQuantity: 1,
            cost: 10,
            date,
          }),
          ctx.actor,
        );
      return product.id;
    };
    // Name order (a, b, c, d) deliberately differs from movement order.
    return {
      a: await make("a", ["2026-03-01"]),
      b: await make("b", ["2026-01-01", "2026-04-01"]),
      c: await make("c", ["2026-02-01"]),
      d: await make("d", []),
    };
  };

  const read = (
    input: Partial<Parameters<typeof getProductMovementTimeline>[1]> & {
      pageIndex: number;
    },
  ) =>
    getProductMovementTimeline(ctx.db, {
      filters: { nameFilter: "Paged timeline" },
      order: "desc",
      ...input,
      pagination: { pageIndex: input.pageIndex, pageSize: 2 },
    });

  it("pages movers newest first by latest movement and counts the whole scope", async () => {
    const { a, b, c } = await seed();

    const first = await read({ pageIndex: 0 });
    const second = await read({ pageIndex: 1 });
    expect(first.products.map((product) => product.id)).toEqual([b, a]);
    expect(second.products.map((product) => product.id)).toEqual([c]);
    expect(first.meta).toEqual({ totalCount: 3, pageIndex: 0, pageSize: 2 });
    expect(first.summary.matchingProducts).toBe(4);
    expect(first.omitted.productsWithoutMovements).toBe(1);
    // Events belong to the page's products only.
    expect(
      new Set(
        first.groups.flatMap((group) =>
          group.movements.map((movement) => movement.productId),
        ),
      ),
    ).toEqual(new Set([b, a]));
    expect((await read({ pageIndex: 2 })).products).toEqual([]);
  });

  it("pages oldest first by first movement", async () => {
    const { a, b, c } = await seed();

    const first = await read({ pageIndex: 0, order: "asc" });
    const second = await read({ pageIndex: 1, order: "asc" });
    expect(first.products.map((product) => product.id)).toEqual([b, c]);
    expect(second.products.map((product) => product.id)).toEqual([a]);
  });

  it("orders and counts by movements inside the window", async () => {
    const { a, b, c, d } = await seed();

    const windowed = await read({
      pageIndex: 0,
      ids: [a, b, c, d],
      from: "2026-01-15",
      to: "2026-03-15",
    });
    expect(windowed.products.map((product) => product.id)).toEqual([a, c]);
    expect(windowed.meta.totalCount).toBe(2);
    expect(windowed.summary.matchingProducts).toBe(4);
  });
});

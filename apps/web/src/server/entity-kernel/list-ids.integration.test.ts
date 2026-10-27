import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { location, ingredient } from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createInventoryFixture,
  createLocationFixture,
  makeLocationInput,
  createProductFixture,
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { executeEntitySelectionIds } from "./selection-ids";

/**
 * `filters.ids` restricts a kernel list to named rows. Failure mode: it drops
 * the requested order, paging or casing rules.
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
      sort: [{ orderBy: "name", direction: "asc" }],
      pagination: { pageIndex, pageSize: 1 },
    });

  it("reads only the named rows, in list order, among many others", async () => {
    const wanted = await Promise.all(
      ["Ids alpha", "Ids beta"].map((name) =>
        findOrCreateIngredient(ctx.db, name),
      ),
    );
    const codes = wanted.map((row) => row.shortcode);
    const small = await listIds(codes);

    for (let index = 0; index < 120; index += 1)
      await findOrCreateIngredient(ctx.db, `Ids filler ${index}`);
    const large = await listIds(codes);
    const second = await listIds(
      codes.map((code) => code.toLowerCase()),
      1,
    );

    for (const result of [small, large, second]) {
      if (result.action !== "list") throw new Error("expected list");
      expect(result.meta.totalCount).toBe(2);
    }
    if (large.action !== "list" || second.action !== "list")
      throw new Error("expected list");
    expect(large.items.map((row) => row.name)).toEqual(["Ids alpha"]);
    expect(second.items.map((row) => row.name)).toEqual(["Ids beta"]);
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
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Unselected item", price: 999 }),
      ctx.actor,
    );
    await drainStoredDerived(ctx.db);
    for (const pageIndex of [0, 1]) {
      const result = await executeEntity(context(), {
        action: "list",
        entity: "product",
        filters: { ids: wanted.map((row) => row.id.toLowerCase()) },
        sort: [{ orderBy: "name", direction: "asc" }],
        pagination: { pageIndex, pageSize: 1 },
      });
      if (result.action !== "list") throw new Error("expected list");
      expect(result.items).toHaveLength(1);
      expect(result.meta.totalCount).toBe(2);
      expect(result.meta.sums).toMatchObject({ price: 30, expenseTotal: 0 });
    }
  });
  it("intersects hand-built inventory predicates before pagination and valuation totals", async () => {
    const item = await createProductIdentityFixture(
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
    await drainStoredDerived(ctx.db);
    for (const pageIndex of [0, 1]) {
      const result = await executeEntity(context(), {
        action: "list",
        entity: "inventory",
        filters: {
          ids: entries.slice(0, 2).map((row) => row.id.toLowerCase()),
          productId: [item.id],
        },
        sort: [{ orderBy: "amount", direction: "asc" }],
        pagination: { pageIndex, pageSize: 1 },
      });
      if (result.action !== "list") throw new Error("expected list");
      expect(result.items).toHaveLength(1);
      expect(result.meta.totalCount).toBe(2);
      expect(result.meta.sums).toMatchObject({ valuation: 30 });
    }
  });
});

// Identity enumeration must retain list scope and page until complete without
// loading full records or silently imposing the former 3,000-row UI cap.
describe("kernel selection identities", () => {
  const ctx = withTestDb();
  it("excludes inventory whose location is no longer in the list population", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Selection population product" }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Selection population shelf", type: "shelf" }),
      ctx.actor,
    );
    const entry = await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const request = {
      entity: "inventory",
      filters: { ids: [entry.id] },
    } as const;
    expect((await executeEntitySelectionIds(context, request)).ids).toEqual([
      entry.id,
    ]);
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.shortcode, shelf.id));
    expect(await executeEntitySelectionIds(context, request)).toEqual({
      ids: [],
      totalCount: 0,
      nextCursor: null,
    });
    const list = await executeEntity(context, {
      action: "list",
      entity: "inventory",
      filters: { ids: [entry.id] },
    });
    if (list.action !== "list") throw new Error("expected list");
    expect(list.items).toEqual([]);
  });
  it("returns canonical public IDs in bounded cursor pages with a full count", async () => {
    const wanted = [];
    for (const name of ["Select alpha", "Select beta", "Select gamma"])
      wanted.push(await findOrCreateIngredient(ctx.db, name));
    await findOrCreateIngredient(ctx.db, "Outside selection");
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await executeEntitySelectionIds(context, {
        entity: "ingredient",
        filters: { ids: wanted.map((row) => row.shortcode) },
        limit: 2,
        cursor,
      });
      expect(page.totalCount).toBe(3);
      expect(page.ids.length).toBeLessThanOrEqual(2);
      ids.push(...page.ids);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(ids.sort()).toEqual(wanted.map((row) => row.shortcode).sort());
  });
  it("refuses a same-count replacement of the canonical matching population", async () => {
    const original = await findOrCreateIngredient(ctx.db, "Cursor scope alpha");
    const retained = await findOrCreateIngredient(ctx.db, "Cursor scope beta");
    const replacement = await findOrCreateIngredient(
      ctx.db,
      "Cursor scope gamma",
    );
    await getDb(ctx.db)
      .update(ingredient)
      .set({ usuallyOnHand: true })
      .where(eq(ingredient.shortcode, replacement.shortcode));
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const input = {
      entity: "ingredient",
      filters: {
        ids: [original.shortcode, retained.shortcode, replacement.shortcode],
        usuallyOnHand: false,
      },
      limit: 1,
    } as const;
    const first = await executeEntitySelectionIds(context, input);
    if (first.nextCursor === null) throw new Error("expected cursor");
    await getDb(ctx.db)
      .update(ingredient)
      .set({ usuallyOnHand: true })
      .where(eq(ingredient.shortcode, original.shortcode));
    await getDb(ctx.db)
      .update(ingredient)
      .set({ usuallyOnHand: false })
      .where(eq(ingredient.shortcode, replacement.shortcode));
    await expect(
      executeEntitySelectionIds(context, {
        ...input,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("selection population changed");
  });
});

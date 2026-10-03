import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { product } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import {
  createProductFixture as createProduct,
  makeProductInput,
} from "../repo.fixtures";
import { productList, updateProduct } from "./crud";
import { mergeProducts } from "./merge";

const page = { pageIndex: 0, pageSize: 50 };

describe("Product.kind", () => {
  const ctx = withTestDb();

  const kindOf = async (entityId: (typeof product.$inferSelect)["id"]) =>
    (
      await getDb(ctx.db).query.product.findFirst({
        where: eq(product.id, entityId),
        columns: { kind: true },
      })
    )?.kind;

  it("creates unset, updates to a value, and clears back to undecided", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name: "Kind lifecycle sponge" }),
      ctx.actor,
    );
    expect(created.kind).toBeNull();

    const set = await updateProduct(
      ctx.db,
      created.entityId,
      { kind: "consumable" },
      ctx.actor,
    );
    expect(set.product.kind).toBe("consumable");
    expect(await kindOf(created.entityId)).toBe("consumable");

    await updateProduct(ctx.db, created.entityId, { kind: null }, ctx.actor);
    expect(await kindOf(created.entityId)).toBeNull();
  });

  it("stores an explicit kind at create independent of stockTracked", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Kind durable stool",
        kind: "durable",
        stockTracked: false,
      }),
      ctx.actor,
    );
    expect(created.kind).toBe("durable");
    expect(created.stockTracked).toBe(false);
  });

  it("refuses a value outside the CHECK", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name: "Kind check victim" }),
      ctx.actor,
    );
    let cause = "";
    try {
      await getDb(ctx.db).execute(
        sql`UPDATE "Product" SET "kind" = 'perishable' WHERE "id" = ${created.entityId}`,
      );
    } catch (error) {
      // Drizzle wraps the driver error; the constraint name rides on the cause.
      if (error instanceof Error) cause = String(error.cause);
    }
    expect(cause).toContain("Product_kind_check");
  });

  it("filters by kind and finds Products with no kind yet", async () => {
    const consumable = await createProduct(
      ctx.db,
      makeProductInput({ name: "Kind filter caulk", kind: "consumable" }),
      ctx.actor,
    );
    const durable = await createProduct(
      ctx.db,
      makeProductInput({ name: "Kind filter drill", kind: "durable" }),
      ctx.actor,
    );
    const unset = await createProduct(
      ctx.db,
      makeProductInput({ name: "Kind filter mystery" }),
      ctx.actor,
    );
    const idsFor = async (filters: Parameters<typeof productList>[1]) =>
      new Set(
        (await productList(ctx.db, filters, [], page)).data.map((r) => r.id),
      );

    const consumables = await idsFor({ kind: ["consumable"] });
    expect(consumables.has(consumable.id)).toBe(true);
    expect(consumables.has(durable.id)).toBe(false);
    expect(consumables.has(unset.id)).toBe(false);

    const undecided = await idsFor({ kindPresenceFilter: "none" });
    expect(undecided.has(unset.id)).toBe(true);
    expect(undecided.has(consumable.id)).toBe(false);
    expect(undecided.has(durable.id)).toBe(false);
  });

  describe("merge", () => {
    it("fills an undecided survivor from the merged-away Product", async () => {
      const keeper = await createProduct(
        ctx.db,
        makeProductInput({ name: "Kind merge keeper A", model: "KIND-A1" }),
        ctx.actor,
      );
      const loser = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Kind merge loser A",
          model: "KIND-A2",
          kind: "consumable",
        }),
        ctx.actor,
      );

      const summary = await mergeProducts(
        ctx.db,
        { keepId: keeper.id, mergeIds: [loser.id] },
        ctx.actor,
      );

      expect(summary.carriedFields).toContain("kind");
      expect(await kindOf(keeper.entityId)).toBe("consumable");
    });

    it("keeps the survivor's kind when the merged-away Product disagrees", async () => {
      const keeper = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Kind merge keeper B",
          model: "KIND-B1",
          kind: "durable",
        }),
        ctx.actor,
      );
      const loser = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Kind merge loser B",
          model: "KIND-B2",
          kind: "consumable",
        }),
        ctx.actor,
      );

      const summary = await mergeProducts(
        ctx.db,
        { keepId: keeper.id, mergeIds: [loser.id] },
        ctx.actor,
      );

      expect(summary.carriedFields).not.toContain("kind");
      expect(await kindOf(keeper.entityId)).toBe("durable");
    });
  });
});

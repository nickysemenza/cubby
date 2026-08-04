import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "./repo.fixtures";
import { createWish, wishList } from "./wish";

const pagination = { pageIndex: 0, pageSize: 50 };

/**
 * `wishFilterFields` spreads `auditDateFilterFields` and `wishRelatedFilterFields`,
 * and the filter manifest renders controls for both — so if `buildWishWhere`
 * doesn't apply them, the UI sends filters the server silently ignores. That is
 * the same manifest/server drift the wishlist rebuild set out to remove, only
 * pointing the other way, and nothing else catches it: the manifest unit test
 * checks that every emitted field EXISTS on the schema, not that the repo reads
 * it.
 */
describe("wishList filters", () => {
  const ctx = withTestDb();

  it("applies the related-candidate search the manifest exposes", async () => {
    const matching = await createProduct(
      ctx.db,
      makeProductInput({ name: "Domino Joining Machine", category: "tools" }),
      ctx.actor,
    );
    const other = await createProduct(
      ctx.db,
      makeProductInput({ name: "Unrelated Bench Grinder", category: "tools" }),
      ctx.actor,
    );
    const { output: wanted } = await createWish(
      ctx.db,
      {
        name: "loose tenon joinery",
        notes: null,
        candidateProductIds: [matching.id],
      },
      ctx.actor,
    );
    await createWish(
      ctx.db,
      {
        name: "sharpening station",
        notes: null,
        candidateProductIds: [other.id],
      },
      ctx.actor,
    );

    const { data } = await wishList(
      ctx.db,
      { productSearch: "Domino" },
      [],
      pagination,
    );
    expect(data.map((row) => row.id)).toEqual([wanted.id]);
  });

  it("applies the audit date range the manifest exposes", async () => {
    const { output: created } = await createWish(
      ctx.db,
      { name: "audit range wish", notes: null, candidateProductIds: [] },
      ctx.actor,
    );

    // A window starting well after every row was created must exclude it. Left
    // unapplied, `createdFrom` is dropped and this returns the row anyway.
    const future = await wishList(
      ctx.db,
      { createdFrom: "2999-01-01" },
      [],
      pagination,
    );
    expect(future.data.map((row) => row.id)).not.toContain(created.id);

    const past = await wishList(
      ctx.db,
      { createdFrom: "2000-01-01" },
      [],
      pagination,
    );
    expect(past.data.map((row) => row.id)).toContain(created.id);
  });
});

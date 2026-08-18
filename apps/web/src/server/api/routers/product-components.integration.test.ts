/**
 * Router-level coverage for the `ProductComponent` procedures
 * (`product.components` / `.kitMembership` / `.attachComponents` /
 * `.detachComponents`). The repo layer (`product-components.integration.test.ts`)
 * already pins the SQL invariants — quantity round-tripping, the partial
 * unique index, the delete-disposition asymmetry. What's only observable here
 * is the router's own job: turning shortcodes into ids and back, and 404ing
 * on a bad one rather than ever leaking a uuid into a payload.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { productRouter } from "./product";

describe("product component procedures", () => {
  const ctx = withTestDb();

  it("attaches, lists both directions by shortcode, and detaches idempotently", async () => {
    const caller = createTestCaller(productRouter, ctx.db);
    const kit = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Router Combo Kit" }),
      ctx.actor,
    );
    const drill = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Router Bare Drill" }),
      ctx.actor,
    );
    const battery = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Router Battery Pack" }),
      ctx.actor,
    );

    const attached = await caller.attachComponents({
      parentProductId: kit.id,
      components: [
        { productId: drill.id, quantity: 1 },
        { productId: battery.id, quantity: 2 },
      ],
    });
    expect(attached).toEqual({ changed: 2, attached: 2 });

    const components = await caller.components({ parentProductId: kit.id });
    expect(
      components.map((c) => ({
        productId: c.productId,
        quantity: c.quantity,
      })),
    ).toEqual([
      { productId: drill.id, quantity: 1 },
      { productId: battery.id, quantity: 2 },
    ]);
    // Every id on the wire is a shortcode, never the uuid PK.
    for (const c of components) {
      expect(c.productId).not.toBe(drill.entityId);
      expect(c.productId).not.toBe(battery.entityId);
    }

    const kits = await caller.kitMembership({ productId: battery.id });
    expect(kits).toHaveLength(1);
    expect(kits[0]).toMatchObject({
      parentProductId: kit.id,
      parentProductName: "Router Combo Kit",
      quantity: 2,
    });

    const detached = await caller.detachComponents({
      parentProductId: kit.id,
      componentProductIds: [battery.id],
    });
    expect(detached).toEqual({ changed: 1, attached: 1 });

    // Idempotent: detaching an already-gone link reports nothing changed,
    // not an error.
    const detachedAgain = await caller.detachComponents({
      parentProductId: kit.id,
      componentProductIds: [battery.id],
    });
    expect(detachedAgain).toEqual({ changed: 0, attached: 1 });

    expect(await caller.kitMembership({ productId: battery.id })).toEqual([]);
  });

  it("404s on a bad parent shortcode rather than leaking a uuid", async () => {
    const caller = createTestCaller(productRouter, ctx.db);
    const part = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Orphan Part" }),
      ctx.actor,
    );

    await expect(
      caller.components({ parentProductId: "PRD-ZZZZ" }),
    ).rejects.toMatchObject({ cause: { reason: "PRODUCT_NOT_FOUND" } });

    await expect(
      caller.attachComponents({
        parentProductId: "PRD-ZZZZ",
        components: [{ productId: part.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ cause: { reason: "PRODUCT_NOT_FOUND" } });
  });

  it("404s on a bad component shortcode inside attach/detach", async () => {
    const caller = createTestCaller(productRouter, ctx.db);
    const kit = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Bad Component Kit" }),
      ctx.actor,
    );

    await expect(
      caller.attachComponents({
        parentProductId: kit.id,
        components: [{ productId: "PRD-ZZZZ", quantity: 1 }],
      }),
    ).rejects.toMatchObject({ cause: { reason: "PRODUCT_NOT_FOUND" } });

    await expect(
      caller.detachComponents({
        parentProductId: kit.id,
        componentProductIds: ["PRD-ZZZZ"],
      }),
    ).rejects.toMatchObject({ cause: { reason: "PRODUCT_NOT_FOUND" } });
  });
});

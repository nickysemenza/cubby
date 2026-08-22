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
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
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
    // `alreadySatisfied` names the no-op bucket: 0 here, since both links are new.
    expect(attached).toEqual({ changed: 2, attached: 2, alreadySatisfied: 0 });

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
    expect(detached).toEqual({ changed: 1, attached: 1, alreadySatisfied: 0 });

    // Idempotent: detaching an already-gone link reports nothing changed,
    // not an error.
    const detachedAgain = await caller.detachComponents({
      parentProductId: kit.id,
      componentProductIds: [battery.id],
    });
    // The point of `alreadySatisfied`: `changed: 0` alone could not distinguish
    // "already detached" from "refused". Now it says which.
    expect(detachedAgain).toEqual({
      changed: 0,
      attached: 1,
      alreadySatisfied: 1,
    });

    expect(await caller.kitMembership({ productId: battery.id })).toEqual([]);
  });

  /**
   * A decomposed kit holds no stock of its own — the shelf claim moved to its
   * parts — so "where did the set go?" is only answerable from the component
   * rows. This pins the three states they can report.
   *
   * `0` and `null` are deliberately different answers: zero is a part that is
   * genuinely unaccounted for, null is a part whose entries carry incompatible
   * units so no single number is true. The count itself comes from
   * `loadProductPickerQuantities`, which is why a bin in service as a Location
   * counts as a held unit here exactly as it does on the products list.
   */
  it("reports each component's on-hand units, including zero and mixed", async () => {
    const caller = createTestCaller(productRouter, ctx.db);
    const kit = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Nightstand Set" }),
      ctx.actor,
    );
    const stocked = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "A Stocked Nightstand" }),
      ctx.actor,
    );
    const unaccounted = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "B Unaccounted Drawer Pull" }),
      ctx.actor,
    );
    const mixed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "C Mixed Unit Filler" }),
      ctx.actor,
    );

    // Two rooms, one unit each — the production shape of PRD-SKNH.
    for (const name of ["Sunroom", "Guest bedroom"]) {
      const room = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name }),
        ctx.actor,
      );
      await createInventoryFixture(
        ctx.db,
        {
          productId: stocked.id,
          locationId: room.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    }

    // Incompatible units on one product: summing `each` against `box` yields a
    // number that means nothing, so the loader refuses to produce one. The two
    // rows need two locations — `(productId, locationId, placement)` is unique,
    // so a product cannot hold two differently-united entries in one place.
    for (const [name, amount] of [
      ["Shed", { value: 1, unit: "each" }],
      ["Basement", { value: 2, unit: "box" }],
    ] as const) {
      const where = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name }),
        ctx.actor,
      );
      await createInventoryFixture(
        ctx.db,
        { productId: mixed.id, locationId: where.id, amount },
        ctx.actor,
      );
    }

    await caller.attachComponents({
      parentProductId: kit.id,
      components: [
        { productId: stocked.id, quantity: 2 },
        { productId: unaccounted.id, quantity: 1 },
        { productId: mixed.id, quantity: 1 },
      ],
    });

    const components = await caller.components({ parentProductId: kit.id });
    expect(
      components.map((c) => ({
        productId: c.productId,
        onHandUnits: c.onHandUnits,
      })),
    ).toEqual([
      { productId: stocked.id, onHandUnits: 2 },
      { productId: unaccounted.id, onHandUnits: 0 },
      { productId: mixed.id, onHandUnits: null },
    ]);
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

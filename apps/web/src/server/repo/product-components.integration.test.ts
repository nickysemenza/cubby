/**
 * `ProductComponent` — what a kit or multi-pack Product is made of. The cases
 * that matter are the ones only real SQL can pin: the partial-unique index
 * (re-attaching after a detach stays legal), the asymmetric edge roles
 * (deleting a kit cascades its component list; deleting a product still
 * listed inside a live kit is blocked), and quantity round-tripping.
 */
import type { ProductId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { image, product, productComponent } from "~/server/db/schema";

import { getDb, notDeleted } from "./database-helpers";
import { deleteProducts, updateProduct } from "./product";
import {
  attachProductComponents,
  detachProductComponents,
  listKitMembership,
  listProductComponents,
} from "./product-components";
import { attachPurchaseProducts } from "./purchase-products";
import {
  createImageFixture,
  createProductFixture as createProduct,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import { findOrCreateVendor } from "./vendor";

describe("product ⟷ product component links (kit composition)", () => {
  const ctx = withTestDb();

  const livePairs = (parentProductId: ProductId) =>
    getDb(ctx.db)
      .select({ componentProductId: productComponent.componentProductId })
      .from(productComponent)
      .where(
        and(
          eq(productComponent.parentProductId, parentProductId),
          notDeleted(productComponent),
        ),
      );

  it("attaches idempotently, lists both directions with quantity, and detaches", async () => {
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Combo Kit" }),
      ctx.actor,
    );
    const drill = await createProduct(
      ctx.db,
      makeProductInput({ name: "Bare Drill" }),
      ctx.actor,
    );
    const battery = await createProduct(
      ctx.db,
      makeProductInput({ name: "Battery Pack" }),
      ctx.actor,
    );
    const kitManual = await createImageFixture(ctx.db, "combo-kit-manual", {
      contentType: PDF_CONTENT_TYPE,
    });
    const kitCover = await createImageFixture(ctx.db, "combo-kit-cover");
    const drillMissing = await createImageFixture(ctx.db, "drill-missing");
    const drillCover = await createImageFixture(ctx.db, "drill-cover");
    await updateProduct(
      ctx.db,
      kit.entityId,
      {
        pendingImageIds: [
          parseShortcodeFor("image", kitManual.shortcode),
          parseShortcodeFor("image", kitCover.shortcode),
        ],
      },
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      drill.entityId,
      {
        pendingImageIds: [
          parseShortcodeFor("image", drillMissing.shortcode),
          parseShortcodeFor("image", drillCover.shortcode),
        ],
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(image)
      .set({ storageStatus: "missing" })
      .where(eq(image.id, drillMissing.id));

    const first = await attachProductComponents(
      ctx.db,
      kit.entityId,
      [
        { productId: drill.entityId, quantity: 1 },
        { productId: battery.entityId, quantity: 2 },
      ],
      ctx.actor,
    );
    expect(first).toEqual({ changed: 2, attached: 2, alreadySatisfied: 0 });

    // Idempotent: the partial unique absorbs the repeat rather than erroring.
    // `alreadySatisfied: 1` is the substantiation for that idempotency claim —
    // the one requested id that needed no write because it was already live.
    const repeat = await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: drill.entityId, quantity: 1 }],
      ctx.actor,
    );
    expect(repeat).toEqual({ changed: 0, attached: 2, alreadySatisfied: 1 });

    const components = await listProductComponents(ctx.db, kit.entityId);
    expect(
      components.map((c) => ({ name: c.productName, quantity: c.quantity })),
    ).toEqual([
      { name: "Bare Drill", quantity: 1 },
      { name: "Battery Pack", quantity: 2 },
    ]);
    expect(components[0]?.coverImageUrl).toBe(drillCover.url);
    expect(components[1]?.coverImageUrl).toBeNull();

    const kits = await listKitMembership(ctx.db, battery.entityId);
    expect(kits).toHaveLength(1);
    expect(kits[0]?.parentProductName).toBe("Combo Kit");
    expect(kits[0]?.quantity).toBe(2);
    expect(kits[0]?.coverImageUrl).toBe(kitCover.url);

    const detached = await detachProductComponents(
      ctx.db,
      kit.entityId,
      [battery.entityId],
      ctx.actor,
    );
    expect(detached).toEqual({ changed: 1, attached: 1, alreadySatisfied: 0 });
    expect(await livePairs(kit.entityId)).toHaveLength(1);

    // Detaching something already gone is a no-op, not an error — and now
    // `alreadySatisfied` says exactly that, rather than leaving `changed: 0`
    // to stand for both "no-op" and "rejected".
    const again = await detachProductComponents(
      ctx.db,
      kit.entityId,
      [battery.entityId],
      ctx.actor,
    );
    expect(again).toEqual({ changed: 0, attached: 1, alreadySatisfied: 1 });
  });

  it("refuses a self-referencing component", async () => {
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Self Reference Kit" }),
      ctx.actor,
    );

    await expect(
      attachProductComponents(
        ctx.db,
        kit.entityId,
        [{ productId: kit.entityId, quantity: 1 }],
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      reason: "PRODUCT_COMPONENT_SELF_REFERENCE",
    });
  });

  // The batched, list-shaped read behind kit row expansion. Distinct from
  // `listProductComponents` above: that returns the 7-field detail projection,
  // this returns whole product list rows so a component can render in the same
  // columns as its parent.

  describe("multi-hop cycle guard — the DB CHECK only catches one hop", () => {
    it("refuses a two-step attach that closes a cycle several hops down", async () => {
      const a = await createProduct(
        ctx.db,
        makeProductInput({ name: "Cycle A" }),
        ctx.actor,
      );
      const b = await createProduct(
        ctx.db,
        makeProductInput({ name: "Cycle B" }),
        ctx.actor,
      );
      const c = await createProduct(
        ctx.db,
        makeProductInput({ name: "Cycle C" }),
        ctx.actor,
      );

      await attachProductComponents(
        ctx.db,
        a.entityId,
        [{ productId: b.entityId, quantity: 1 }],
        ctx.actor,
      );
      await attachProductComponents(
        ctx.db,
        b.entityId,
        [{ productId: c.entityId, quantity: 1 }],
        ctx.actor,
      );

      // Closing the loop — C lists A — makes A reach itself three hops later.
      // Neither the one-hop self-reference check nor the DB CHECK sees this;
      // only walking the whole live edge set does.
      await expect(
        attachProductComponents(
          ctx.db,
          c.entityId,
          [{ productId: a.entityId, quantity: 1 }],
          ctx.actor,
        ),
      ).rejects.toMatchObject({
        reason: "PRODUCT_COMPONENT_CYCLE",
      });

      expect(await livePairs(c.entityId)).toHaveLength(0);
    });
  });

  describe("delete disposition — the two edges are asymmetric on purpose", () => {
    it("blocks deleting a product still listed inside a live kit, and allows it once detached", async () => {
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Blocking Kit" }),
        ctx.actor,
      );
      const part = await createProduct(
        ctx.db,
        makeProductInput({ name: "Blocking Component" }),
        ctx.actor,
      );
      await attachProductComponents(
        ctx.db,
        kit.entityId,
        [{ productId: part.entityId, quantity: 1 }],
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [part.entityId], ctx.actor),
      ).rejects.toMatchObject({
        reason: "PRODUCT_HAS_KIT_LINKS",
      });

      await detachProductComponents(
        ctx.db,
        kit.entityId,
        [part.entityId],
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [part.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });
    });

    it("deleting the kit cascades its component rows, without touching the component products", async () => {
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Cascade Kit" }),
        ctx.actor,
      );
      const partA = await createProduct(
        ctx.db,
        makeProductInput({ name: "Cascade Part A" }),
        ctx.actor,
      );
      const partB = await createProduct(
        ctx.db,
        makeProductInput({ name: "Cascade Part B" }),
        ctx.actor,
      );
      await attachProductComponents(
        ctx.db,
        kit.entityId,
        [
          { productId: partA.entityId, quantity: 1 },
          { productId: partB.entityId, quantity: 4 },
        ],
        ctx.actor,
      );

      const before = await getDb(ctx.db).query.productComponent.findMany({
        where: eq(productComponent.parentProductId, kit.entityId),
      });
      expect(before).toHaveLength(2);

      await expect(
        deleteProducts(ctx.db, [kit.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });

      // The component rows are soft-deleted along with the kit...
      const after = await getDb(ctx.db).query.productComponent.findMany({
        where: eq(productComponent.parentProductId, kit.entityId),
      });
      for (const row of after) {
        expect(row.deletedAt).not.toBeNull();
      }
      expect(await livePairs(kit.entityId)).toHaveLength(0);

      // ...but the component Products themselves are untouched — the
      // composition edge cascades, it does not retain, and it must never
      // reach past the join row to the parts it names.
      const [liveA, liveB] = await Promise.all([
        getDb(ctx.db).query.product.findFirst({
          where: eq(product.id, partA.entityId),
        }),
        getDb(ctx.db).query.product.findFirst({
          where: eq(product.id, partB.entityId),
        }),
      ]);
      expect(liveA?.deletedAt).toBeNull();
      expect(liveB?.deletedAt).toBeNull();
    });
  });

  describe("ProductComponent constraints", () => {
    it("rejects a quantity below 1 at the database", async () => {
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Zero Quantity Kit" }),
        ctx.actor,
      );
      const part = await createProduct(
        ctx.db,
        makeProductInput({ name: "Zero Quantity Part" }),
        ctx.actor,
      );

      await expect(
        getDb(ctx.db).insert(productComponent).values({
          parentProductId: kit.entityId,
          componentProductId: part.entityId,
          quantity: 0,
        }),
        // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
      ).rejects.toThrow();
    });

    it("rejects two live rows for the same (kit, component) pair", async () => {
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Duplicate Pair Kit" }),
        ctx.actor,
      );
      const part = await createProduct(
        ctx.db,
        makeProductInput({ name: "Duplicate Pair Part" }),
        ctx.actor,
      );

      await getDb(ctx.db).insert(productComponent).values({
        parentProductId: kit.entityId,
        componentProductId: part.entityId,
        quantity: 1,
      });

      await expect(
        getDb(ctx.db).insert(productComponent).values({
          parentProductId: kit.entityId,
          componentProductId: part.entityId,
          quantity: 2,
        }),
        // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
      ).rejects.toThrow();
    });
  });

  describe("kit membership provenance — price, expense count, and most recent purchase", () => {
    it("names the kit's price, live expense count, and most recent purchase on the transpose", async () => {
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Priced Combo Kit", price: 249 }),
        ctx.actor,
      );
      const battery = await createProduct(
        ctx.db,
        makeProductInput({ name: "Provenance Battery" }),
        ctx.actor,
      );
      await attachProductComponents(
        ctx.db,
        kit.entityId,
        [{ productId: battery.entityId, quantity: 1 }],
        ctx.actor,
      );

      await insertWithShortcode(ctx.db, "expense", {
        name: "Kit deposit",
        cost: 100,
        date: "2026-01-01",
        lineKind: "principal",
        costType: "materials",
        trade: "other",
        future: false,
        productId: kit.entityId,
        productQuantity: 1,
      });
      await insertWithShortcode(ctx.db, "expense", {
        name: "Kit balance",
        cost: 149,
        date: "2026-01-02",
        lineKind: "principal",
        costType: "materials",
        trade: "other",
        future: false,
        productId: kit.entityId,
        productQuantity: null,
      });

      // Two purchases attached to the kit, so the query must pick the more
      // recent one by date, not just the last one inserted.
      const vendorId = await findOrCreateVendor(ctx.db, "Provenance Vendor");
      const earlierPurchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId,
        date: "2026-01-01",
        orderId: "#EARLY",
      });
      const laterPurchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId,
        date: "2026-01-05",
        orderId: "#LATE",
      });
      await attachPurchaseProducts(
        ctx.db,
        earlierPurchase.id,
        [kit.entityId],
        ctx.actor,
      );
      await attachPurchaseProducts(
        ctx.db,
        laterPurchase.id,
        [kit.entityId],
        ctx.actor,
      );

      const membership = await listKitMembership(ctx.db, battery.entityId);
      expect(membership).toHaveLength(1);
      const [entry] = membership;
      expect(entry?.parentProductName).toBe("Priced Combo Kit");
      // The manual price wins outright — no Expense on the component itself.
      expect(entry?.price).toBe(249);
      expect(entry?.expenseCount).toBe(2);
      expect(entry?.purchase?.orderId).toBe("#LATE");
      expect(entry?.purchase?.vendorName).toBe("Provenance Vendor");
    });
  });
});

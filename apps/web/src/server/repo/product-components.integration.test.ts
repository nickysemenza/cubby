/**
 * `ProductComponent` — what a kit or multi-pack Product is made of. The cases
 * that matter are the ones only real SQL can pin: the partial-unique index
 * (re-attaching after a detach stays legal), the asymmetric edge roles
 * (deleting a kit cascades its component list; deleting a product still
 * listed inside a live kit is blocked), and quantity round-tripping.
 */
import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  auditLog,
  expense as expenseTable,
  product,
  productComponent,
} from "~/server/db/schema";
import { getDb, notDeleted } from "./database-helpers";
import { deleteProducts } from "./product";
import {
  attachProductComponents,
  detachProductComponents,
  listKitMembership,
  listProductComponents,
} from "./product-components";
import {
  attachPurchaseProducts,
  detachPurchaseProducts,
} from "./purchase-products";
import {
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

    const first = await attachProductComponents(
      ctx.db,
      kit.entityId,
      [
        { productId: drill.entityId, quantity: 1 },
        { productId: battery.entityId, quantity: 2 },
      ],
      ctx.actor,
    );
    expect(first).toEqual({ changed: 2, attached: 2 });

    // Idempotent: the partial unique absorbs the repeat rather than erroring.
    const repeat = await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: drill.entityId, quantity: 1 }],
      ctx.actor,
    );
    expect(repeat).toEqual({ changed: 0, attached: 2 });

    const components = await listProductComponents(ctx.db, kit.entityId);
    expect(
      components.map((c) => ({ name: c.productName, quantity: c.quantity })),
    ).toEqual([
      { name: "Bare Drill", quantity: 1 },
      { name: "Battery Pack", quantity: 2 },
    ]);

    const kits = await listKitMembership(ctx.db, battery.entityId);
    expect(kits).toHaveLength(1);
    expect(kits[0]?.parentProductName).toBe("Combo Kit");
    expect(kits[0]?.quantity).toBe(2);

    const detached = await detachProductComponents(
      ctx.db,
      kit.entityId,
      [battery.entityId],
      ctx.actor,
    );
    expect(detached).toEqual({ changed: 1, attached: 1 });
    expect(await livePairs(kit.entityId)).toHaveLength(1);

    // Detaching something already gone is a no-op, not an error.
    const again = await detachProductComponents(
      ctx.db,
      kit.entityId,
      [battery.entityId],
      ctx.actor,
    );
    expect(again.changed).toBe(0);
  });

  it("allows re-attaching a detached pair — the unique index is partial", async () => {
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Re-attach Kit" }),
      ctx.actor,
    );
    const part = await createProduct(
      ctx.db,
      makeProductInput({ name: "Re-attach Part" }),
      ctx.actor,
    );

    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: part.entityId, quantity: 3 }],
      ctx.actor,
    );
    await detachProductComponents(
      ctx.db,
      kit.entityId,
      [part.entityId],
      ctx.actor,
    );
    const reattached = await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: part.entityId, quantity: 5 }],
      ctx.actor,
    );

    expect(reattached).toEqual({ changed: 1, attached: 1 });
    const rows = await livePairs(kit.entityId);
    expect(rows).toHaveLength(1);

    // The fresh row after re-attach carries the NEW quantity, not the old one
    // — quantity is set at attach time, not merged with a prior tombstone.
    const components = await listProductComponents(ctx.db, kit.entityId);
    expect(components[0]?.quantity).toBe(5);
  });

  it("writes an audit entry naming the component set before and after", async () => {
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Audited Kit" }),
      ctx.actor,
    );
    const part = await createProduct(
      ctx.db,
      makeProductInput({ name: "Audited Part" }),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: part.entityId, quantity: 1 }],
      ctx.actor,
    );

    const entries = await getDb(ctx.db)
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "product"),
          eq(auditLog.entityId, kit.entityId),
        ),
      );

    const linkChange = entries.find(
      (e) =>
        (e.changes as { componentProductIds?: { to?: string[] } } | null)
          ?.componentProductIds !== undefined,
    );
    expect(linkChange).toBeDefined();
    const changes = linkChange?.changes as {
      componentProductIds: { from: string[]; to: string[] };
    };
    expect(changes.componentProductIds.from).toEqual([]);
    expect(changes.componentProductIds.to).toHaveLength(1);
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
      cause: { reason: "PRODUCT_COMPONENT_SELF_REFERENCE" },
    });
  });

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

      // A lists B, B lists C — individually acyclic, two hops deep.
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
        cause: { reason: "PRODUCT_COMPONENT_CYCLE" },
      });

      // The refused attach wrote nothing.
      expect(await livePairs(c.entityId)).toHaveLength(0);
    });

    it("allows a legitimate deep chain — a kit inside a kit inside a kit", async () => {
      const outer = await createProduct(
        ctx.db,
        makeProductInput({ name: "Outer Kit" }),
        ctx.actor,
      );
      const middle = await createProduct(
        ctx.db,
        makeProductInput({ name: "Middle Kit" }),
        ctx.actor,
      );
      const inner = await createProduct(
        ctx.db,
        makeProductInput({ name: "Inner Part" }),
        ctx.actor,
      );

      await attachProductComponents(
        ctx.db,
        outer.entityId,
        [{ productId: middle.entityId, quantity: 1 }],
        ctx.actor,
      );
      const result = await attachProductComponents(
        ctx.db,
        middle.entityId,
        [{ productId: inner.entityId, quantity: 3 }],
        ctx.actor,
      );

      expect(result).toEqual({ changed: 1, attached: 1 });
      const components = await listProductComponents(ctx.db, middle.entityId);
      expect(components[0]?.quantity).toBe(3);
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
        cause: { reason: "PRODUCT_HAS_KIT_LINKS" },
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

      // Two live Expenses on the kit itself — the component carries neither.
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

    it("reports zero expenses and no purchase for a kit that hasn't been bought yet", async () => {
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unbought Kit" }),
        ctx.actor,
      );
      const part = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unbought Part" }),
        ctx.actor,
      );
      await attachProductComponents(
        ctx.db,
        kit.entityId,
        [{ productId: part.entityId, quantity: 1 }],
        ctx.actor,
      );

      const [entry] = await listKitMembership(ctx.db, part.entityId);
      expect(entry?.price).toBeNull();
      expect(entry?.expenseCount).toBe(0);
      expect(entry?.purchase).toBeNull();
    });

    it("ignores a soft-deleted Expense and a soft-deleted purchase link when counting the kit's own provenance", async () => {
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Soft-Deleted Provenance Kit" }),
        ctx.actor,
      );
      const part = await createProduct(
        ctx.db,
        makeProductInput({ name: "Soft-Deleted Provenance Part" }),
        ctx.actor,
      );
      await attachProductComponents(
        ctx.db,
        kit.entityId,
        [{ productId: part.entityId, quantity: 1 }],
        ctx.actor,
      );

      const deletedExpense = await insertWithShortcode(ctx.db, "expense", {
        name: "Retracted expense",
        cost: 50,
        date: "2026-01-01",
        lineKind: "principal",
        costType: "materials",
        trade: "other",
        future: false,
        productId: kit.entityId,
        productQuantity: 1,
      });
      await getDb(ctx.db)
        .update(expenseTable)
        .set({ deletedAt: new Date() })
        .where(eq(expenseTable.id, deletedExpense.id));

      const vendorId = await findOrCreateVendor(
        ctx.db,
        "Soft-Deleted Provenance Vendor",
      );
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId,
        date: "2026-01-01",
        orderId: "#SOFT",
      });
      const attach = await attachPurchaseProducts(
        ctx.db,
        purchase.id,
        [kit.entityId],
        ctx.actor,
      );
      expect(attach.changed).toBe(1);
      const detach = await detachPurchaseProducts(
        ctx.db,
        purchase.id,
        [kit.entityId],
        ctx.actor,
      );
      expect(detach.changed).toBe(1);

      const [entry] = await listKitMembership(ctx.db, part.entityId);
      expect(entry?.expenseCount).toBe(0);
      expect(entry?.purchase).toBeNull();
    });
  });
});

import { filterOptionsInput } from "@cubby/schemas/filter-options";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
/**
 * `PurchaseProduct` — the provenance link between an order and the Products it
 * bought. The cases that matter are the ones the partial-unique index makes
 * non-obvious: re-attaching after a detach, and what a merge does when both
 * sides already name the same pair (a bare re-point would abort the whole
 * transaction on the unique index rather than produce a wrong answer).
 */
import type { ProductShortcode, PurchaseId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  entityLink,
  expense,
  product,
  purchase,
  vendor,
} from "~/server/db/schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import { getProductMovementTimeline } from "~/server/domains/product/repo/movement-timeline";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { executeEntity } from "~/server/entity-kernel";
import { getEntityGraph } from "~/server/generic/entity-graph/repo/entity-graph";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";
import {
  loadRelatedBranch,
  loadRelatedPreviews,
  relatedWhereConditions,
} from "~/server/generic/entity-links/repo/related-view";
import { getFilterOptions } from "~/server/generic/list/repo/filter-options";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import {
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  attachPurchaseProducts,
  detachPurchaseProducts,
  listProductPurchases,
  listPurchaseProducts,
  listPurchaseProductsPage,
  listProductPurchasesPage,
  confirmPurchaseAcquisition,
} from "./purchase-products";

describe("purchase ↔ product links", () => {
  const ctx = withTestDb();

  const mkPurchase = async (label: string, vendorName = "Link Test Vendor") => {
    const vendorId = await findOrCreateVendor(ctx.db, vendorName);
    return insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-02-01",
      displayLabel: label,
    });
  };

  const livePairs = (purchaseId: PurchaseId) =>
    getDb(ctx.db)
      .select({ productId: entityLink.toEntityId })
      .from(entityLink)
      .where(
        and(
          eq(entityLink.fromEntityId, purchaseId),
          liveLinks("purchaseProduct"),
        ),
      );

  // The Expense leg. These reads answer "which order acquired this", and the
  // Expense ledger — not `PurchaseProduct` — establishes that for all but a
  // handful of pairs. Every case below was invisible before the union landed.
  describe("expense-derived rows", () => {
    // `productId` here is the product SHORTCODE — `createExpense` resolves it,
    // unlike the list functions below, which take the branded id (`entityId`).
    const expenseOn = async (args: {
      name: string;
      cost: number;
      productId: ProductShortcode;
      productQuantity: number | null;
      orderId: string;
      future?: boolean;
    }) =>
      createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({
          date: "2026-03-01",
          vendor: "Expense Leg Vendor",
          ...args,
        }),
      );

    // SQL union, source overlap, liveness, and list predicates can diverge
    // independently; a single browser card does not exercise these consumers.
    it("includes every live expense pair and unions explicit evidence across relation consumers", async () => {
      const item = await createProduct(
        ctx.db,
        makeProductInput({ name: "Relationship evidence item" }),
        ctx.actor,
      );
      const mixed = await mkPurchase("Mixed evidence");
      const linked = await mkPurchase("Linked evidence");
      const planned = await mkPurchase("Planned evidence");
      const retired = await mkPurchase("Retired evidence");
      // Undated orders sort after dated orders in both paged and full reads.
      await getDb(ctx.db)
        .update(purchase)
        .set({ date: null })
        .where(eq(purchase.id, linked.id));
      for (const line of [
        { cost: 20, productQuantity: 1 },
        { cost: -5, productQuantity: 0 },
        { cost: -10, productQuantity: -1 },
        { cost: 0, productQuantity: -1 },
        { cost: null, productQuantity: null },
        { cost: 25, productQuantity: 1, future: true },
      ])
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Evidence line",
            productId: item.id,
            purchaseId: mixed.shortcode,
            ...line,
          }),
          ctx.actor,
        );
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: "Planned line",
          productId: item.id,
          purchaseId: planned.shortcode,
          future: true,
        }),
        ctx.actor,
      );
      const deletedLine = await createExpense(
        ctx.db,
        makeExpenseInput({
          name: "Deleted line",
          productId: item.id,
          purchaseId: retired.shortcode,
        }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(expense)
        .set({ deletedAt: new Date() })
        .where(eq(expense.id, deletedLine.entityId));
      await attachPurchaseProducts(
        ctx.db,
        mixed.id,
        [item.entityId],
        ctx.actor,
      );
      await attachPurchaseProducts(
        ctx.db,
        linked.id,
        [item.entityId],
        ctx.actor,
      );
      await attachPurchaseProducts(
        ctx.db,
        planned.id,
        [item.entityId],
        ctx.actor,
      );

      const inverse = await listProductPurchases(ctx.db, item.entityId);
      expect(inverse).toHaveLength(3);
      expect(inverse.at(-1)?.purchaseId).toBe(linked.shortcode);
      expect(
        inverse.find((row) => row.purchaseId === mixed.shortcode),
      ).toMatchObject({
        source: "both",
        linkAttachedAt: expect.any(Date),
        movementKinds: [
          "acquired",
          "exited",
          "discarded",
          "adjusted",
          "unknown",
        ],
        hasPlanned: true,
      });
      expect(
        inverse.find((row) => row.purchaseId === linked.shortcode),
      ).toMatchObject({ source: "link", movementKinds: [], hasPlanned: false });
      expect(
        inverse.find((row) => row.purchaseId === planned.shortcode),
      ).toMatchObject({ source: "both", movementKinds: [], hasPlanned: true });
      expect(await listPurchaseProducts(ctx.db, mixed.id)).toMatchObject([
        { productId: item.id, source: "both", hasPlanned: true },
      ]);
      // Pair deduplication precedes paging/counting; equal dates still have a
      // stable tie-breaker, and a later page retains the same provenance.
      const pages = await Promise.all(
        [0, 1, 2].map((offset) =>
          listProductPurchasesPage(ctx.db, item.entityId, { offset, limit: 1 }),
        ),
      );
      expect(pages.map((page) => page.totalCount)).toEqual([3, 3, 3]);
      expect(
        new Set(
          pages.flatMap((page) => page.items.map((row) => row.purchaseId)),
        ).size,
      ).toBe(3);
      expect(pages.flatMap((page) => page.items)).toEqual(inverse);
      const kernel = requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      );
      expect(
        await executeEntity(kernel, {
          action: "listRelation",
          entity: "product",
          relation: "purchases",
          id: item.id,
          offset: 1,
          limit: 1,
        }),
      ).toMatchObject({ items: pages[1]!.items, totalCount: 3 });
      expect(
        await listProductPurchasesPage(ctx.db, item.entityId, {
          offset: 1,
          limit: 1,
          targetIds: [mixed.shortcode],
        }),
      ).toEqual({ items: [], totalCount: 1 });
      expect(
        await listPurchaseProductsPage(ctx.db, mixed.id, {
          offset: 0,
          limit: 1,
        }),
      ).toMatchObject({
        totalCount: 1,
        items: [{ productId: item.id, source: "both", hasPlanned: true }],
      });
      const previews = await loadRelatedPreviews(ctx.db, {
        source: "product",
        sourceIds: [item.id],
        relationKeys: ["product.purchases"],
      });
      expect(previews[0]?.totalCount).toBe(3);
      const branch = await loadRelatedBranch(ctx.db, {
        relationKey: "product.purchases",
        sourceId: item.id,
        limit: 50,
        offset: 0,
      });
      expect(new Set(branch.items.map((row) => row.id))).toEqual(
        new Set([mixed.shortcode, linked.shortcode, planned.shortcode]),
      );
      expect(
        await loadRelatedBranch(ctx.db, {
          relationKey: "purchase.products",
          sourceId: linked.shortcode,
          limit: 50,
          offset: 0,
        }),
      ).toMatchObject({ totalCount: 1, items: [{ id: item.id }] });
      const roster = (input: {
        search?: string;
        cursor?: string;
        selectedIds?: string[];
      }) =>
        getFilterOptions(
          ctx.db,
          filterOptionsInput.parse({
            source: "relation",
            relationKey: "product.purchases",
            limit: 1,
            ...input,
          }),
        );
      const first = await roster({});
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await roster({ cursor: first.nextCursor ?? undefined });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      const last = await roster({ cursor: second.nextCursor ?? undefined });
      expect(last.nextCursor).toBeNull();
      expect(
        new Set(
          [...first.items, ...second.items, ...last.items].map((row) => row.id),
        ),
      ).toEqual(
        new Set([mixed.shortcode, linked.shortcode, planned.shortcode]),
      );
      const searched = await roster({
        search: linked.shortcode,
        selectedIds: [planned.shortcode],
      });
      expect(searched.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: linked.shortcode, count: 1 }),
          expect.objectContaining({ id: planned.shortcode, count: 1 }),
        ]),
      );
      expect(searched.nextCursor).toBeNull();
      const filtered = await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(
          relatedWhereConditions(
            "product",
            { purchaseId: linked.shortcode },
            product.id,
          )[0],
        );
      expect(filtered).toEqual([{ id: item.entityId }]);
      const graph = await getEntityGraph(ctx.db, {
        roots: [{ entityKind: "product", entityId: item.id }],
        relationshipKeys: ["purchases"],
      });
      expect(graph.branches[0]?.totalCount).toBe(3);
      const timeline = await getProductMovementTimeline(ctx.db, {
        filters: {},
        ids: [item.id],
        order: "desc",
        pagination: { pageIndex: 0, pageSize: 20 },
      });
      expect(
        timeline.groups.find(
          (group) => group.purchase?.id === planned.shortcode,
        )?.movements,
      ).toMatchObject([
        { kind: "linked", provenanceOnly: true, signedQuantity: null },
      ]);
      await detachPurchaseProducts(
        ctx.db,
        mixed.id,
        [item.entityId],
        ctx.actor,
      );
      expect(await listPurchaseProducts(ctx.db, mixed.id)).toMatchObject([
        { source: "expense", linkAttachedAt: null },
      ]);
      expect(
        await executeEntity(kernel, {
          action: "listRelation",
          entity: "purchase",
          relation: "products",
          id: mixed.shortcode,
          offset: 0,
          limit: 1,
        }),
      ).toMatchObject({
        totalCount: 1,
        items: [{ source: "expense", linkAttachedAt: null, hasPlanned: true }],
      });
      await getDb(ctx.db)
        .update(purchase)
        .set({ deletedAt: new Date() })
        .where(eq(purchase.id, linked.id));
      expect(await listProductPurchases(ctx.db, item.entityId)).toHaveLength(2);
    });

    it("keeps an order whose refund sits beside a real acquisition", async () => {
      const saw = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Saw" }),
        ctx.actor,
      );
      const firstSeller = await createRepoEntity(ctx, "vendor", {
        name: "Expense Leg Vendor",
      });
      await expenseOn({
        name: "Union Saw",
        cost: 120,
        productId: saw.id,
        productQuantity: 1,
        orderId: "UNION-REFUND",
      });
      // A partial refund on a kept item, and a returned second unit, are both
      // ordinary inside an order that still bought something.
      await expenseOn({
        name: "Union Saw price adjustment",
        cost: -20,
        productId: saw.id,
        productQuantity: 0,
        orderId: "UNION-REFUND",
      });

      const purchases = await listProductPurchases(ctx.db, saw.entityId);
      expect(purchases).toHaveLength(1);
      expect(purchases[0]?.source).toBe("expense");
      const secondSeller = await createRepoEntity(ctx, "vendor", {
        name: "Second acquisition vendor",
      });
      const otherPurchase = await createRepoEntity(ctx, "purchase", {
        vendorId: secondSeller.output.id,
        date: "2026-03-02",
      });
      for (const cost of [25, 25, 5, -80, null])
        await createRepoEntity(
          ctx,
          "expense",
          makeExpenseInput({
            productId: saw.id,
            purchaseId: otherPurchase.output.id,
            name: "Repeated acquisition evidence",
            cost,
            date: "2026-03-02",
          }),
        );
      // A refund-only Purchase does not prove a seller or a buyer. It must
      // not create a No-seller membership beside this Product's known sellers.
      await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({
          name: "Unclassified refund",
          productId: saw.id,
          productQuantity: -1,
          cost: -7,
          vendor: "Unclassified counterparty",
          orderId: "UNCLASSIFIED-REFUND",
          date: "2026-03-03",
        }),
      );
      const noSeller = await createProduct(
        ctx.db,
        makeProductInput({ name: "No actual acquisition seller" }),
        ctx.actor,
      );
      for (const line of [
        { cost: 10, future: true, economicRole: "vendor" },
        { cost: -15, future: false, economicRole: "reimbursement" },
        {
          cost: -100,
          productQuantity: -1,
          future: false,
          economicRole: "vendor",
        },
      ] as const)
        await createRepoEntity(
          ctx,
          "expense",
          makeExpenseInput({
            name: "Non-acquisition evidence",
            productId: noSeller.id,
            purchaseId: otherPurchase.output.id,
            date: "2026-03-02",
            ...line,
          }),
        );
      const kernel = requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      );
      const memberships = [];
      for (const pageIndex of [0, 1, 2]) {
        const result = await executeEntity(kernel, {
          action: "list",
          entity: "product",
          filters: { ids: [saw.id, noSeller.id] },
          groupBy: [{ key: "sellers" }],
          pagination: { pageIndex, pageSize: 1 },
        });
        if (result.action !== "list") throw new Error("expected list");
        expect(result.meta.totalCount).toBe(2);
        expect(result.meta.membershipCount).toBe(3);
        memberships.push(...(result.meta.memberships ?? []));
      }
      expect(memberships).toEqual([
        { id: saw.id, path: [firstSeller.output.id] },
        { id: saw.id, path: [secondSeller.output.id] },
        { id: noSeller.id, path: [FILTER_NONE] },
      ]);
      for (const filters of [
        { sellerId: [firstSeller.output.id] },
        { sellersPresenceFilter: "none" as const },
      ]) {
        const result = await executeEntity(kernel, {
          action: "list",
          entity: "product",
          filters: { ids: [saw.id, noSeller.id], ...filters },
          groupBy: [{ key: "sellers" }],
          pagination: { pageIndex: 0, pageSize: 10 },
        });
        if (result.action !== "list") throw new Error("expected list");
        expect(result.meta.totalCount).toBe(1);
        expect(result.meta.memberships).toEqual(
          "sellerId" in filters
            ? memberships.slice(0, 2)
            : memberships.slice(2),
        );
      }
      await getDb(ctx.db)
        .update(vendor)
        .set({ deletedAt: new Date() })
        .where(eq(vendor.id, secondSeller.entityId));
      const surviving = await executeEntity(kernel, {
        action: "list",
        entity: "product",
        filters: { ids: [saw.id] },
        groupBy: [{ key: "sellers" }],
        pagination: { pageIndex: 0, pageSize: 10 },
      });
      if (surviving.action !== "list") throw new Error("expected list");
      expect(surviving.meta.memberships).toEqual(memberships.slice(0, 1));
    });
  });

  it("attaches idempotently, lists both directions, and detaches", async () => {
    const order = await mkPurchase("appliances");
    const range = await createProduct(
      ctx.db,
      makeProductInput({ name: "Link Range" }),
      ctx.actor,
    );
    const fridge = await createProduct(
      ctx.db,
      makeProductInput({ name: "Link Fridge" }),
      ctx.actor,
    );

    const first = await attachPurchaseProducts(
      ctx.db,
      order.id,
      [range.entityId, fridge.entityId],
      ctx.actor,
    );
    expect(first).toEqual({ changed: 2, attached: 2, alreadySatisfied: 0 });

    // Idempotent: the partial unique absorbs the repeat rather than erroring.
    // `alreadySatisfied: 1` is the substantiation for that idempotency claim —
    // the one requested id that needed no write because it was already live.
    const repeat = await attachPurchaseProducts(
      ctx.db,
      order.id,
      [range.entityId],
      ctx.actor,
    );
    expect(repeat).toEqual({ changed: 0, attached: 2, alreadySatisfied: 1 });

    const products = await listPurchaseProducts(ctx.db, order.id);
    expect(products.map((p) => p.productName)).toEqual([
      "Link Fridge",
      "Link Range",
    ]);

    const purchases = await listProductPurchases(ctx.db, range.entityId);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]?.displayLabel).toBe("appliances");
    const kernel = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const sellers = () =>
      executeEntity(kernel, {
        action: "list",
        entity: "product",
        filters: { ids: [range.id, fridge.id] },
        groupBy: [{ key: "sellers" }],
        pagination: { pageIndex: 0, pageSize: 10 },
      });
    const linkedOnly = await sellers();
    if (linkedOnly.action !== "list") throw new Error("expected list");
    expect(linkedOnly.meta.groups).toMatchObject([
      { label: "No seller", count: 2 },
    ]);
    await confirmPurchaseAcquisition(ctx.db, {
      purchaseId: order.shortcode,
      productId: range.id,
    });
    const confirmed = await sellers();
    if (confirmed.action !== "list") throw new Error("expected list");
    expect(confirmed.meta.groups).toMatchObject([
      { label: "Link Test Vendor", count: 1 },
      { label: "No seller", count: 1 },
    ]);

    const detached = await detachPurchaseProducts(
      ctx.db,
      order.id,
      [fridge.entityId],
      ctx.actor,
    );
    expect(detached).toEqual({ changed: 1, attached: 1, alreadySatisfied: 0 });
    expect(await livePairs(order.id)).toHaveLength(1);

    // Detaching something already gone is a no-op, not an error — and now
    // `alreadySatisfied` says exactly that, rather than leaving `changed: 0`
    // to stand for both "no-op" and "rejected".
    const again = await detachPurchaseProducts(
      ctx.db,
      order.id,
      [fridge.entityId],
      ctx.actor,
    );
    expect(again).toEqual({ changed: 0, attached: 1, alreadySatisfied: 1 });
  });

  /**
   * PRODUCT_NOT_FOUND: the shared `relation-preflight.ts` refusal for a
   * target that plainly does not resolve any more — here, a soft-deleted
   * product named by a stale id.
   */

  it("folds to exactly one live pair when merging two products onto the same order", async () => {
    // Both products link the SAME purchase, so a blind re-point would violate
    // the partial unique and abort. `foldAssociation` re-points what fits and
    // soft-deletes the collision.
    const order = await mkPurchase("product merge");
    const keeper = await createProduct(
      ctx.db,
      makeProductInput({ name: "Merge Keeper" }),
      ctx.actor,
    );
    const loser = await createProduct(
      ctx.db,
      makeProductInput({ name: "Merge Loser" }),
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      order.id,
      [keeper.entityId, loser.entityId],
      ctx.actor,
    );

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );
    expect(summary.purchaseLinksMoved).toBe(0);

    const pairs = await livePairs(order.id);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.productId).toBe(keeper.entityId);
  });
});

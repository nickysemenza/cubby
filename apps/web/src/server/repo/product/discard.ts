/**
 * Throwing something away, as a ledger event.
 *
 * A discard is the one product exit that moves no money: nothing is sold and
 * nothing is refunded, so `cost` is 0 and the negative `productQuantity` is
 * the entire signal that a unit left. (Never a null cost — `cost IS NULL` is
 * already the Unclassified-spend predicate.) Before quantities were signed
 * this event was indistinguishable from a free promotional acquisition, which
 * is exactly the ambiguity the essay above `findSoldButStillStocked` records.
 *
 * Two shapes are load-bearing here:
 *
 *  - **No Purchase.** There is no vendor charge behind throwing something out.
 *    Attaching the discard to whichever order originally bought the item —
 *    which is what the one historical discard did — makes it inherit that
 *    vendor and order id for an event that can be years later, and puts a line
 *    on an order that never contained it. `purchaseId` is nullable precisely
 *    for rows with nothing to attach to.
 *
 *  - **The shelf moves in the same transaction, and only when asked.**
 *    Inventory never auto-decrements is a binding tenet, and this does not
 *    breach it: nothing here is a side effect of recording money. It is an
 *    explicit human action, on a dialog that names the shelf and the count,
 *    behind a checkbox the operator can clear. What the tenet forbids is
 *    inferring consumption; what it does not forbid is doing what the operator
 *    just said to do, atomically, so expected and actual cannot diverge in the
 *    gap between two writes.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ExpenseId,
  InventoryId,
  ProductId,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import { touchDataQualityTargets } from "~/server/repo/data-quality";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { computeValuationForEntry } from "~/server/repo/inventory/crud";
import {
  pricingProductIds,
  syncChangedEffectivePrices,
} from "~/server/repo/product/price-sync";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import { cascadeRemoval } from "~/server/repo/removal";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export type DiscardProductInput = {
  productId: ProductId;
  quantity: number;
  date: string;
  reason: string | null;
  /** Null leaves inventory alone — the operator cleared the checkbox. */
  inventoryEntryId: InventoryId | null;
};

export type DiscardProductResult = {
  /** Both forms: the uuid drives side effects, the shortcode is what the API returns. */
  expenseId: ExpenseId;
  expenseShortcode: string;
  storedQuantity: number;
  productShortcode: ProductShortcode;
  inventory: {
    entryId: InventoryId;
    entryShortcode: string;
    removed: boolean;
    remainingValue: number | null;
  } | null;
  priceAffectedProductIds: ProductId[];
};

export const discardProductUnits = async (
  db: Database,
  input: DiscardProductInput,
  actor: ActorContext,
): Promise<DiscardProductResult> =>
  withTransaction(db, async (tx) => {
    // Re-checked inside the transaction even though the router resolved the
    // shortcode: a preview or a resolve is advisory, the mutation is not.
    const prod = await tx.query.product.findFirst({
      where: and(eq(product.id, input.productId), notDeleted(product)),
      columns: { id: true, name: true, shortcode: true },
    });
    if (!prod) {
      throw createAppError("PRODUCT_NOT_FOUND", "Product not found.");
    }

    const pricesBefore = await loadEffectiveProductPricesById(
      tx,
      pricingProductIds([input.productId]),
    );

    const storedQuantity = -Math.abs(input.quantity);
    const created = await insertWithShortcode(tx, "expense", {
      name: `Discarded — ${prod.name}`,
      cost: 0,
      date: input.date,
      // A Product may only hang off a principal line.
      lineKind: "principal",
      costType: "tools",
      trade: "other",
      url: null,
      notes: input.reason,
      future: false,
      // A $0 line moves no budget, so attributing it to a project would only
      // add a zero row to that project's ledger.
      projectId: null,
      productId: input.productId,
      productQuantity: storedQuantity,
      purchaseId: null,
    });
    await logAuditEntry(tx, actor, {
      entityType: "expense",
      entityId: created.id,
      action: "create",
    });

    let inventory: DiscardProductResult["inventory"] = null;
    if (input.inventoryEntryId !== null) {
      // includes-installed: caller names an exact entry by id — an
      // installed fixture must be dischargeable the same as shelf stock.
      const entry = await tx.query.inventoryEntry.findFirst({
        where: and(
          eq(inventoryEntry.id, input.inventoryEntryId),
          eq(inventoryEntry.productId, input.productId),
          notDeleted(inventoryEntry),
        ),
        columns: { id: true, shortcode: true, amount: true },
      });
      if (!entry) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "That inventory entry does not belong to this product, or is no longer live.",
        );
      }

      // Over-discard is ALLOWED, unlike the sibling subtraction in
      // repo/inventory/bulk.ts, which throws CONSTRAINT_VIOLATION when a move
      // exceeds what the source holds. The deviation is deliberate:
      //
      //  - A move refuses because moving more than exists corrupts a
      //    *destination*. A discard is terminal; there is nothing downstream.
      //  - Tenet 1 makes the shelf a ballpark — "a stale-tolerant estimate".
      //    Shelf says 3, there were really 5, all 5 went in the bin is a real
      //    and common discard, and refusing it would make a knowingly-approximate
      //    number authoritative over the operator standing at the bin.
      //  - Nothing here can tell a stale shelf from a fat finger. The human can,
      //    which is why that check lives in ProductDiscardDialog as a warning at
      //    the moment of entry rather than as a guard here.
      //
      // So `remaining < 0` intentionally lands in the same branch as `=== 0`:
      // the entry empties, and the Expense keeps the quantity the operator
      // stated. Covered by "empties the entry when more is discarded than the
      // shelf holds" in discard.integration.test.ts.
      const remaining = entry.amount.value - Math.abs(input.quantity);
      if (remaining > 0) {
        const remainingAmount = { ...entry.amount, value: remaining };
        await tx
          .update(inventoryEntry)
          .set({
            amount: remainingAmount,
            valuation: await computeValuationForEntry(
              tx,
              input.productId,
              remainingAmount,
            ),
          })
          .where(eq(inventoryEntry.id, entry.id));
        await logAuditEntry(tx, actor, {
          entityType: "inventory",
          entityId: entry.id,
          action: "update",
        });
        inventory = {
          entryId: entry.id,
          entryShortcode: entry.shortcode,
          removed: false,
          remainingValue: remaining,
        };
      } else {
        await tx
          .update(inventoryEntry)
          .set({ deletedAt: new Date() })
          .where(eq(inventoryEntry.id, entry.id));
        await cascadeRemoval(tx, {
          entity: "inventory",
          ids: [entry.id],
          audit: { actor },
        });
        inventory = {
          entryId: entry.id,
          entryShortcode: entry.shortcode,
          removed: true,
          remainingValue: null,
        };
      }
    }

    await touchDataQualityTargets(tx, { productIds: [input.productId] });

    // A cost-0 line cannot move a `cost > 0`-filtered aggregate, so this is
    // expected to be empty. Kept for structural parity with `createExpense`:
    // if the pricing predicate ever widens, a discard must not be the one
    // write path that quietly skipped the sync.
    const priceAffectedProductIds = await syncChangedEffectivePrices(
      tx,
      pricesBefore,
    );

    return {
      expenseId: created.id,
      expenseShortcode: created.shortcode,
      storedQuantity,
      productShortcode: unsafeProductShortcode(prod.shortcode),
      inventory,
      priceAffectedProductIds,
    };
  });

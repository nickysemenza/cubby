import type { ActorContext } from "@cubby/schemas/context";
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
import type {
  ExpenseId,
  InventoryId,
  ProductId,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProductDiscardPreviewInput,
  ProductDiscardPreviewOut,
} from "@cubby/schemas/product";
import { tradeSchema, type Trade } from "@cubby/schemas/task-fields";
import { and, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import { touchDataQualityTargets } from "~/server/repo/data-quality/touch";
import {
  amountFromColumns,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { describeDiscard } from "~/server/repo/product/discard-preview";
import { loadProductInventoryEntries } from "~/server/repo/product/lookup";
import {
  pricingProductIds,
  syncChangedEffectivePrices,
} from "~/server/repo/product/price-sync";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import { cascadeRemoval } from "~/server/repo/removal/core";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export type DiscardProductInput = {
  trade: Trade;
  productId: ProductId;
  quantity: number;
  date: string | null;
  reason: string | null;
  /** Null with `adjustInventory` unset leaves inventory alone. */
  inventoryEntryId: InventoryId | null;
  /**
   * The operator asked to take the units off a shelf. The server owns the
   * default: a sole live entry is chosen here, several with none named are
   * refused (never guessed), none records a ledger-only exit.
   */
  adjustInventory?: boolean;
};

/** One ledger line and what it did to the shelf, before per-request work. */
type DiscardLineResult = {
  /** Both forms: the uuid drives side effects, the shortcode is what the API returns. */
  expenseId: ExpenseId;
  expenseShortcode: string;
  storedQuantity: number;
  productId: ProductId;
  productShortcode: ProductShortcode;
  inventory: {
    entryId: InventoryId;
    entryShortcode: string;
    removed: boolean;
    remainingValue: number | null;
  } | null;
};

export type DiscardProductResult = DiscardLineResult & {
  priceAffectedProductIds: ProductId[];
};

/**
 * The per-item core: one ledger line, and the shelf draw-down that goes with
 * it, inside a transaction the CALLER owns.
 *
 * Split out so the bulk path can write N lines under one boundary. Everything
 * that is per-request rather than per-line — the effective-price snapshot, the
 * data-quality touch, the price sync — stays with the caller so it happens
 * once regardless of how many rows were submitted.
 */
const writeDiscardLine = async (
  tx: DrizzleTransaction,
  input: DiscardProductInput,
  actor: ActorContext,
): Promise<DiscardLineResult> => {
  // Re-checked inside the transaction even though the router resolved the
  // shortcode: a preview or a resolve is advisory, the mutation is not.
  const prod = await tx.query.product.findFirst({
    where: and(eq(product.id, input.productId), notDeleted(product)),
    columns: { id: true, name: true, shortcode: true },
  });
  if (!prod) {
    throw createAppError("PRODUCT_NOT_FOUND", "Product not found.");
  }

  const storedQuantity = -Math.abs(input.quantity);
  const created = await insertWithShortcode(tx, "expense", {
    name: `Discarded — ${prod.name}`,
    cost: 0,
    date: input.date,
    // A Product may only hang off a principal line.
    lineKind: "principal",
    costType: "tools",
    trade: tradeSchema.parse(input.trade),
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
    entityKind: "expense",
    entityId: created.id,
    action: "create",
  });

  let inventory: DiscardLineResult["inventory"] = null;
  if (input.inventoryEntryId !== null) {
    // includes-installed: caller names an exact entry by id — an
    // installed fixture must be dischargeable the same as shelf stock.
    const entry = await tx.query.inventoryEntry.findFirst({
      where: and(
        eq(inventoryEntry.id, input.inventoryEntryId),
        eq(inventoryEntry.productId, input.productId),
        notDeleted(inventoryEntry),
      ),
      columns: {
        id: true,
        shortcode: true,
        amountValue: true,
        amountUnit: true,
      },
    });
    if (!entry) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "That inventory entry does not belong to this product, or is no longer live.",
      );
    }

    // Over-discard is ALLOWED here, unlike the sibling subtraction in
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
    //
    // {@link discardFromInventoryEntries} is the ONE caller that refuses it
    // instead — see the guard there for why a multi-row selection is not the
    // place to trust a number over the shelf.
    const remaining = entry.amountValue - Math.abs(input.quantity);
    if (remaining > 0) {
      await tx
        .update(inventoryEntry)
        .set({ amountValue: remaining })
        .where(eq(inventoryEntry.id, entry.id));
      await logAuditEntry(tx, actor, {
        entityKind: "inventory",
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

  return {
    expenseId: created.id,
    expenseShortcode: created.shortcode,
    storedQuantity,
    productId: prod.id,
    productShortcode: parseShortcodeFor("product", prod.shortcode),
    inventory,
  };
};

/**
 * Which shelf entry a single-product discard draws from. Clients that do not
 * name one (native) must still decrement a product that sits on exactly one
 * shelf; a product on several shelves needs an explicit choice.
 */
const resolveDiscardShelf = async (
  tx: DrizzleTransaction,
  input: DiscardProductInput,
): Promise<InventoryId | null> => {
  if (input.inventoryEntryId !== null || !input.adjustInventory) {
    return input.inventoryEntryId;
  }
  const live = await tx.query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, input.productId),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true },
  });
  if (live.length > 1) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "This product is on several shelves; name which inventory entry to take the units from.",
    );
  }
  return live[0]?.id ?? null;
};

export const discardProductUnits = async (
  db: Database,
  input: DiscardProductInput,
  actor: ActorContext,
): Promise<DiscardProductResult> =>
  withTransaction(db, async (tx) => {
    const pricesBefore = await loadEffectiveProductPricesById(
      tx,
      pricingProductIds([input.productId]),
    );

    const inventoryEntryId = await resolveDiscardShelf(tx, input);
    const line = await writeDiscardLine(
      tx,
      { ...input, inventoryEntryId },
      actor,
    );

    await touchDataQualityTargets(tx, { productIds: [input.productId] });

    // A cost-0 line cannot move a `cost > 0`-filtered aggregate, so this is
    // expected to be empty. Kept for structural parity with `createExpense`:
    // if the pricing predicate ever widens, a discard must not be the one
    // write path that quietly skipped the sync.
    const priceAffectedProductIds = await syncChangedEffectivePrices(
      tx,
      pricesBefore,
    );

    return { ...line, priceAffectedProductIds };
  });

export type DiscardFromInventoryInput = {
  trade: Trade;
  items: readonly { inventoryEntryId: InventoryId; quantity: number }[];
  date: string | null;
  reason: string | null;
};

export type DiscardFromInventoryResult = {
  /** One per submitted item, in submission order. `inventory` is never null. */
  items: DiscardLineResult[];
  priceAffectedProductIds: ProductId[];
};

/**
 * Write off units from many shelf rows at once.
 *
 * Shaped like `addInventoryEntries`: one transaction, `items[]`, one
 * price-sync pass — not N client round trips. N ledger lines is the correct
 * output, since a discard IS one zero-cost Expense per product exit; what the
 * single transaction buys is that a refusal on row 3 leaves rows 1 and 2
 * unwritten instead of half a selection recorded.
 *
 * The entry names its own product, so unlike {@link discardProductUnits} there
 * is nothing to ask: the selection already answered which shelf, per row.
 */
export const discardFromInventoryEntries = async (
  db: Database,
  input: DiscardFromInventoryInput,
  actor: ActorContext,
): Promise<DiscardFromInventoryResult> =>
  withTransaction(db, async (tx) => {
    // Two lines against one entry would each read the amount as it stood
    // BEFORE either was applied, so the second would validate against stock
    // the first already took. There is no way to tell which was meant, so
    // refuse rather than silently apply both.
    const seen = new Set<InventoryId>();
    for (const item of input.items) {
      if (seen.has(item.inventoryEntryId)) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "The same inventory entry is listed more than once. Combine the quantities into one line.",
        );
      }
      seen.add(item.inventoryEntryId);
    }

    const entries = await tx.query.inventoryEntry.findMany({
      where: and(
        inArray(inventoryEntry.id, [...seen]),
        notDeleted(inventoryEntry),
      ),
      columns: {
        id: true,
        shortcode: true,
        amountValue: true,
        amountUnit: true,
        productId: true,
      },
    });
    const entryById = new Map(
      entries.map((entry) => [
        entry.id,
        { ...entry, amount: amountFromColumns(entry) },
      ]),
    );

    for (const item of input.items) {
      const entry = entryById.get(item.inventoryEntryId);
      if (!entry) {
        throw createAppError(
          "INVENTORY_NOT_FOUND",
          "One of the selected inventory entries is no longer live.",
        );
      }
      // Refused here, and ALLOWED by `writeDiscardLine` for the single-row
      // product flow — the deviation is the point, not an oversight. That flow
      // is one row under an operator's full attention, on a dialog that warns
      // and offers a different shelf; this one is a selection whose rows each
      // display the amount they hold, with no per-row confirmation. A number
      // above what the row shows is a typo far more often than a stale count,
      // and here it would empty a shelf inside a transaction that is writing
      // several others at the same time. The permissive path stays reachable
      // from the product surfaces for the genuine stale-shelf case.
      if (item.quantity > entry.amount.value) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Cannot discard ${item.quantity} ${entry.amount.unit} from ${entry.shortcode}: it holds ${entry.amount.value}. Discard what is there, or correct the count first.`,
        );
      }
    }

    const productIds = uniq(entries.map((entry) => entry.productId));
    const pricesBefore = await loadEffectiveProductPricesById(
      tx,
      pricingProductIds(productIds),
    );

    const items: DiscardLineResult[] = [];
    for (const item of input.items) {
      const entry = entryById.get(item.inventoryEntryId);
      /* c8 ignore next -- the loop above already refused a missing entry */
      if (!entry) continue;
      items.push(
        await writeDiscardLine(
          tx,
          {
            productId: entry.productId,
            quantity: item.quantity,
            trade: input.trade,
            date: input.date,
            reason: input.reason,
            inventoryEntryId: entry.id,
          },
          actor,
        ),
      );
    }

    await touchDataQualityTargets(tx, { productIds });

    const priceAffectedProductIds = await syncChangedEffectivePrices(
      tx,
      pricesBefore,
    );

    return { items, priceAffectedProductIds };
  });

/**
 * The advisory preview behind the discard confirmation (web dialog and native
 * hero action). Read-only: `discardProductUnits` re-checks everything.
 */
export const previewProductDiscard = async (
  db: Database,
  productId: ProductId,
  input: Pick<
    ProductDiscardPreviewInput,
    "quantity" | "adjustInventory" | "inventoryEntryId"
  >,
): Promise<ProductDiscardPreviewOut> => {
  const prod = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, productId), notDeleted(product)),
    columns: { name: true },
  });
  if (!prod) {
    throw createAppError("PRODUCT_NOT_FOUND", "Product not found.");
  }
  const entries = (await loadProductInventoryEntries(db, [productId])).get(
    productId,
  );
  const shelves = (entries ?? []).map((entry) => ({
    id: entry.id,
    amount: entry.amount,
    location: { id: entry.location.id, name: entry.location.name },
  }));
  return {
    productName: prod.name,
    shelves,
    ...describeDiscard(shelves, input),
  };
};

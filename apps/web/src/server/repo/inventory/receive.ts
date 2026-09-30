import type { ActorContext } from "@cubby/schemas/context";
import type { LocationId } from "@cubby/schemas/identifiers";
import type {
  InventoryReceiveExpenseInput,
  InventoryReceiveExpenseOut,
} from "@cubby/schemas/inventory";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { expense, inventoryEntry, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { resolveArrivedFindingsForPurchase } from "~/server/purchase-import/findings";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  addInventoryEntries,
  type ResolvedInventoryBulkAddPayload,
} from "./bulk";
import { updateInventoryEntry } from "./crud";

function validateReceivingChoice(
  input: InventoryReceiveExpenseInput,
  expectedQuantity: number | null,
  stocked: Array<typeof inventoryEntry.$inferSelect>,
  locationId: LocationId,
) {
  const action = input.action;
  const existing =
    action.kind === "create"
      ? undefined
      : stocked.find((row) => row.shortcode === action.entryId);
  if (action.kind !== "create" && !existing)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The selected inventory entry no longer belongs to this Expense Product; review receiving again.",
    );
  if (
    expectedQuantity === 1 &&
    stocked.length > 0 &&
    (action.kind !== "move" || stocked.length !== 1)
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A one-of-a-kind Product already in inventory must be moved; review its existing entry.",
    );
  }
  if (
    action.kind === "add" &&
    existing &&
    (existing.locationId !== locationId ||
      existing.amountUnit !== action.amount.unit)
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The inventory location or unit changed; review the current entry before adding.",
    );
  }
  if (
    action.kind === "create" &&
    stocked.some(
      (row) =>
        row.locationId === locationId &&
        row.placement === "stock" &&
        row.ownershipMode === "inherit",
    )
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "This Product is already stocked here; review and choose Add to count.",
    );
  }
  return existing;
}

/** Inventory and the arrived finding share a boundary; no purchase writer calls this. */
export const receiveExpenseInventory = async (
  db: Database,
  input: InventoryReceiveExpenseInput,
  actor: ActorContext,
) =>
  withTransactionDatabase(db, async (transactionDb) => {
    const transaction = getDb(transactionDb);
    const expenseId = await resolveOrThrow(
      transactionDb,
      "expense",
      input.expenseId,
    );
    const locationId = await resolveOrThrow(
      transactionDb,
      "location",
      input.locationId,
    );
    const [line] = await transaction
      .select({ productId: expense.productId, purchaseId: expense.purchaseId })
      .from(expense)
      .where(and(eq(expense.id, expenseId), notDeleted(expense)));
    if (!line?.productId)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Receiving requires a live Expense with a Product.",
      );
    const [good] = await transaction
      .select({ id: product.id, expectedQuantity: product.expectedQuantity })
      .from(product)
      .where(and(eq(product.id, line.productId), notDeleted(product)));
    if (!good)
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        "The Expense Product was deleted; review the Expense before receiving.",
      );
    const stocked = await transaction
      .select()
      .from(inventoryEntry)
      .where(
        and(eq(inventoryEntry.productId, good.id), notDeleted(inventoryEntry)),
      );
    const action = input.action;
    const existing = validateReceivingChoice(
      input,
      good.expectedQuantity,
      stocked,
      locationId,
    );
    let item: InventoryReceiveExpenseOut["item"] | undefined;
    if (action.kind === "move" && existing) {
      item = await updateInventoryEntry(
        transactionDb,
        existing.id,
        { locationId },
        actor,
      );
    } else if (action.kind === "create" || action.kind === "add") {
      const toAdd: ResolvedInventoryBulkAddPayload["items"][number] = {
        productId: good.id,
        amount: action.amount,
      };
      if (existing) {
        toAdd.placement = existing.placement;
        toAdd.ownership = {
          ownershipMode: existing.ownershipMode,
          ownerLedgerPartyId: existing.ownerLedgerPartyId,
        };
      }
      const added = await addInventoryEntries(
        transactionDb,
        { locationId, items: [toAdd] },
        actor,
      );
      item = added.items[0];
    }
    if (!item)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Receiving produced no inventory entry.",
      );
    const arrived = line.purchaseId
      ? await resolveArrivedFindingsForPurchase(
          transactionDb,
          { purchaseId: line.purchaseId },
          actor,
        )
      : { resolved: 0 };
    return { item, resolvedArrivedFindings: arrived.resolved };
  });

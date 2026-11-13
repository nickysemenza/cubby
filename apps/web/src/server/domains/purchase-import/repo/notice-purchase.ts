import type { ActorContext } from "@cubby/schemas/context";
import type { EmailPurchaseDecisionValue } from "@cubby/schemas/email-fields";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  LedgerPartyId,
  PurchaseId,
  ShortcodeFor,
  VendorId,
} from "@cubby/schemas/identifiers";
import { mailEvent } from "@cubby/schemas/mailbox-research";
import { and, eq, sql, type SQL } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import { purchase, vendorAccount } from "~/server/db/schema";
import { createPurchaseEventRecord } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";

import { normalizedOrderIdSql, normalizeOrderKey } from "./order-identity";
import {enterHouseholdWrite} from "~/server/kernel/api";
import { recordRunWrites } from "./run-audit";

/**
 * A Purchase waiting for its order details: no live Expense, no accepted
 * import source, and a linked shipping or delivery Email. A lifecycle notice
 * creates it empty; the order's confirmation later itemizes the same Purchase.
 * It holds no money, so spending, settlement and data quality treat it as an
 * expected state rather than a gap.
 */
export const awaitingOrderDetailsSql = (purchaseId: SQL): SQL<boolean> =>
  sql<boolean>`(NOT EXISTS (
    SELECT 1 FROM "Expense" aod_expense
    WHERE aod_expense."purchaseId" = ${purchaseId} AND ${notDeleted("aod_expense")}
  ) AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceOrder" aod_order WHERE aod_order."purchaseId" = ${purchaseId}
  ) AND EXISTS (
    SELECT 1 FROM "EmailPurchaseDecision" aod_link
    JOIN "OrderMailEvent" aod_event ON aod_event.id = aod_link."eventId"
    WHERE aod_link."purchaseId" = ${purchaseId} AND aod_link.active
      AND aod_link.decision = ${"linked" satisfies EmailPurchaseDecisionValue}
      AND aod_event.event IN (${mailEvent.enum.shipped}, ${mailEvent.enum.delivered})
  ))`;

/**
 * Create the empty Purchase a shipping or delivery notice names by its
 * Vendor order number, inside the caller's transaction, so the notice links
 * to it in the same commit. Null when any live Purchase at that Vendor already
 * holds the order number: that Purchase is the target, never a second one.
 * The settlement lock serializes this with the import writer's own
 * order-number lookup.
 */
export async function createNoticePurchase(
  tx: DrizzleTransaction,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorId: VendorId;
    orderKey: string;
    /** The notice's household-local day; the confirmation replaces it. */
    day: string;
    actor: ActorContext;
  },
): Promise<ShortcodeFor<"purchase"> | null> {
  if (!input.actor.runId)
    throw new Error("A notice Purchase is written under its mail import Run");
  await enterHouseholdWrite(tx);
  const [held] = await tx
    .select({ id: purchase.id })
    .from(purchase)
    .where(
      and(
        eq(purchase.vendorId, input.vendorId),
        eq(
          normalizedOrderIdSql(purchase.orderId),
          normalizeOrderKey(input.orderKey),
        ),
        notDeleted(purchase),
      ),
    )
    .limit(1);
  if (held) return null;
  const accounts = await tx
    .select({ id: vendorAccount.id })
    .from(vendorAccount)
    .where(
      and(
        eq(vendorAccount.vendorId, input.vendorId),
        eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
        notDeleted(vendorAccount),
      ),
    )
    .limit(2);
  const created = await createPurchaseEventRecord(tx, "purchase", {
    vendorId: input.vendorId,
    // One account names the member; several leave it to the confirmation.
    vendorAccountId: accounts.length === 1 ? accounts[0]!.id : null,
    runId: input.actor.runId,
    orderId: input.orderKey,
    date: input.day,
  });
  await recordRunWrites(tx, input.actor, [
    {
      entityKind: "purchase",
      entityId: created.id,
      action: "create",
      fields: ["vendorId", "vendorAccountId", "orderId", "date"],
    },
  ]);
  return parseShortcodeFor("purchase", created.shortcode);
}

/** Whether this Purchase still waits for its order details (`awaitingOrderDetailsSql`). */
export async function isAwaitingOrderDetails(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
): Promise<boolean> {
  const [row] = await tx
    .select({ awaiting: awaitingOrderDetailsSql(sql`${purchase.id}`) })
    .from(purchase)
    .where(eq(purchase.id, purchaseId))
    .limit(1);
  return row?.awaiting === true;
}

import type { LedgerPartyId, VendorId } from "@cubby/schemas/identifiers";
import { and, eq, gte, isNotNull, lte, ne } from "drizzle-orm";

import type { Database } from "~/server/db";
import { orderMail, orderMailEvent } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { uniqueOrderSubsetForCharge } from "../writer-policy";

const cents = (value: number) => Math.round(value * 100);

interface HuntWindow {
  ledgerPartyId: LedgerPartyId;
  vendorId: VendorId;
  /** Signed statement amount: charges positive, credits negative. */
  amount: number;
  dateFrom: string;
  dateTo: string;
}

/**
 * One mailed amount per order inside a hunt's date window, in the
 * hunt's direction: refund events only for a credit, other events only for a
 * charge, so a refund is never summed into a charge.
 */
export async function orderAmountsInHuntWindow(db: Database, hunt: HuntWindow) {
  const events = await getDb(db)
    .select({ orderId: orderMailEvent.orderId, amount: orderMailEvent.amount })
    .from(orderMailEvent)
    .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
    .where(
      and(
        eq(orderMail.ledgerPartyId, hunt.ledgerPartyId),
        eq(orderMail.vendorId, hunt.vendorId),
        isNotNull(orderMailEvent.orderId),
        isNotNull(orderMailEvent.amount),
        hunt.amount < 0
          ? eq(orderMailEvent.event, "refunded")
          : ne(orderMailEvent.event, "refunded"),
        gte(
          orderMailEvent.occurredAt,
          new Date(`${hunt.dateFrom}T00:00:00.000Z`),
        ),
        lte(
          orderMailEvent.occurredAt,
          new Date(`${hunt.dateTo}T23:59:59.999Z`),
        ),
      ),
    );
  const byOrder = new Map<string, number>();
  for (const event of events) {
    if (event.orderId && event.amount !== null)
      byOrder.set(event.orderId, Math.abs(event.amount));
  }
  return [...byOrder].map(([id, amount]) => ({ id, amount }));
}

export const uniqueOrderSubsetIds = (
  huntAmount: number,
  orders: { id: string; amount: number }[],
) =>
  uniqueOrderSubsetForCharge(Math.abs(huntAmount), orders)?.map(
    ({ id }) => id,
  ) ?? null;

/**
 * Resolve a new hunt from order mail processed before it existed: the one
 * order of exactly its amount, else the one order subset summing to it.
 */
export async function matchProcessedOrderMail(
  db: Database,
  hunt: HuntWindow,
): Promise<string[] | null> {
  const orders = await orderAmountsInHuntWindow(db, hunt);
  const exact = orders.filter(
    (order) => cents(order.amount) === cents(Math.abs(hunt.amount)),
  );
  if (exact.length === 1) return exact.map(({ id }) => id);
  return uniqueOrderSubsetIds(hunt.amount, orders);
}

import { inArray, eq, and } from "drizzle-orm";

import type { Database } from "~/server/db";
import { evidenceBinding, recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import type { sourceOrderObservation } from "~/server/db/schema";
import { orderEventKey, orderPaymentKeys } from "~/server/domains/purchase-import/policy/payment-keys";
import { reconcileNow } from "~/server/kernel/api";

/** Settle a page without draining model work. Every phase receives the whole page. */
export async function settleOrderEvidence(db: Database, orders: readonly (typeof sourceOrderObservation.$inferSelect)[]) {
  if (!orders.length) return [];
  const paymentKeys = [...new Set(orders.flatMap(orderPaymentKeys))];
  const matching = await reconcileNow(db, paymentKeys.map(key => ({kind: "paymentMatch", key})));
  const bindings = await repositoryQueries(db).select().from(evidenceBinding)
    .where(and(eq(evidenceBinding.factKind, "orderObservation"), inArray(evidenceBinding.factId, orders.map(row => row.id))));
  const keys = [...new Set([...orders.map(orderEventKey), ...bindings.map(row => row.eventKey)])];
  const settled = await reconcileNow(db, keys.map(key => ({kind: "purchaseEvent", key})));
  const records = await repositoryQueries(db).select().from(recordKey)
    .where(and(eq(recordKey.scopeKind,"purchaseEvent"), inArray(recordKey.scopeKey,keys),eq(recordKey.entity,"purchase")));
  const bankKeys = bindings.flatMap(row => {
    const order = orders.find(order => order.id === row.factId);
    return order && row.eventKey !== orderEventKey(order) && records.some(record => record.scopeKey === orderEventKey(order)) ? [row.eventKey] : [];
  });
  if (!bankKeys.length) return [...matching,...settled];
  const merged = await reconcileNow(db, [...new Set(bankKeys)].map(key=>({kind:"purchaseEvent",key})));
  return [...matching,...settled,...merged];
}

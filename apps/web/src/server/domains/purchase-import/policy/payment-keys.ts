import { moneyToMinor } from "@cubby/shared";

import type {
  purchasePaymentEvidence,
  sourceOrderObservation,
} from "~/server/db/retained-tables";
import { normalizeOrderKey } from "~/server/domains/purchase-import/policy/order-identity";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

/** Every payer uses the same exact USD movement key, before either side exists. */
export const paymentAmountKey = (amount: bigint) =>
  `payment:amount:USD:${amount}`;
export const orderEventKey = (
  row: Pick<
    typeof sourceOrderObservation.$inferSelect,
    | "ledgerPartyId"
    | "vendorId"
    | "orderKey"
    | "extraction"
    | "sourceKind"
    | "sourceExternalKey"
    | "sourceClaimId"
  >,
) =>
  row.extraction.candidate?.orderId
    ? `order:${row.ledgerPartyId}:${row.vendorId}/order/${normalizeOrderKey(row.extraction.candidate.orderId)}`
    : `order:${row.ledgerPartyId}:${row.orderKey}/source/${row.sourceKind}:${row.sourceExternalKey || row.sourceClaimId}`;
export const paymentOrderKey = (vendorId: string, orderId: string) =>
  `payment:order:${vendorId}:${normalizeOrderKey(orderId)}`;

export const orderPaymentKeys = (
  row: Pick<
    typeof sourceOrderObservation.$inferSelect,
    | "ledgerPartyId"
    | "vendorId"
    | "orderKey"
    | "extraction"
    | "sourceKind"
    | "sourceExternalKey"
    | "sourceClaimId"
  >,
): string[] => {
  const candidate = row.extraction.candidate;
  if (!candidate) return [];
  const keys = [
    ...new Set([
      ...(candidate.orderId
        ? [paymentOrderKey(row.vendorId, candidate.orderId)]
        : []),
      ...(candidate.currency === "USD"
        ? candidate.payments.map((payment) =>
            paymentAmountKey(moneyToMinor(payment.amount)),
          )
        : []),
    ]),
  ];
  // A payment-free receipt still needs its explicit Purchase assignment routed.
  return keys.length ? keys : [`payment:source:${orderEventKey(row)}`];
};

/** Bank record identities cannot collide with purchase-event scope keys during merges. */
export const paymentBankEventKey = (id: string) => `bank:${id}`;

/** Retained payment rows keep their original source claim and Purchase link;
 * appended observations carry their immutable direct observation link. */
type OrderOriginal = Pick<
  typeof sourceOrderObservation.$inferSelect,
  | "id"
  | "ledgerPartyId"
  | "vendorId"
  | "sourceKind"
  | "sourceExternalKey"
  | "sourceClaimId"
  | "purchaseId"
  | "orderKey"
  | "checksum"
  | "extraction"
  | "createdAt"
>;

/** Binding choices do not retrieve a new original or create another payment fact. */
export function sameOrderOriginal(
  left: OrderOriginal,
  right: OrderOriginal,
): boolean {
  const source = left.sourceExternalKey || left.sourceClaimId;
  return (
    !!left.ledgerPartyId &&
    !!source &&
    left.ledgerPartyId === right.ledgerPartyId &&
    left.vendorId === right.vendorId &&
    left.sourceKind === right.sourceKind &&
    source === (right.sourceExternalKey || right.sourceClaimId) &&
    left.orderKey === right.orderKey &&
    left.checksum === right.checksum &&
    canonicalJson(jsonSnapshot.parse(left.extraction)) ===
      canonicalJson(jsonSnapshot.parse(right.extraction))
  );
}

type PaymentLink = Pick<
  typeof purchasePaymentEvidence.$inferSelect,
  "orderObservationId" | "sourceClaimId" | "purchaseId" | "evidenceIndex"
>;

/** Direct evidence wins over retained claim links for the same frozen original. */
export function createOrderPaymentMatcher(
  originals: readonly OrderOriginal[],
  payments: readonly PaymentLink[],
) {
  const directIndices = new Map<string, Set<number>>();
  for (const payment of payments)
    if (payment.orderObservationId) {
      const indices =
        directIndices.get(payment.orderObservationId) ?? new Set<number>();
      indices.add(payment.evidenceIndex);
      directIndices.set(payment.orderObservationId, indices);
    }
  const captureKey = (row: OrderOriginal) => {
    const source = row.sourceExternalKey || row.sourceClaimId;
    return row.ledgerPartyId && source
      ? canonicalJson(
          jsonSnapshot.parse([
            row.ledgerPartyId,
            row.vendorId,
            row.sourceKind,
            source,
            row.orderKey,
            row.checksum,
            row.extraction,
          ]),
        )
      : null;
  };
  const groups = new Map<
    string,
    { direct: Map<number, OrderOriginal>; retained: Set<string> }
  >();
  const keys = new Map<string, string>();
  for (const original of originals) {
    const key = captureKey(original);
    if (!key) continue;
    keys.set(original.id, key);
    const group = groups.get(key) ?? {
      direct: new Map<number, OrderOriginal>(),
      retained: new Set<string>(),
    };
    if (original.sourceClaimId && original.purchaseId)
      group.retained.add(`${original.sourceClaimId}:${original.purchaseId}`);
    for (const index of directIndices.get(original.id) ?? []) {
      const previous = group.direct.get(index);
      if (
        !previous ||
        original.createdAt > previous.createdAt ||
        (original.createdAt.getTime() === previous.createdAt.getTime() &&
          original.id > previous.id)
      )
        group.direct.set(index, original);
    }
    groups.set(key, group);
  }
  return (payment: PaymentLink, order: OrderOriginal): boolean => {
    const key = keys.get(order.id);
    const group = key ? groups.get(key) : undefined;
    const direct = group?.direct.get(payment.evidenceIndex);
    if (direct) return payment.orderObservationId === direct.id;
    if (payment.orderObservationId !== null)
      return payment.orderObservationId === order.id;
    if (!payment.sourceClaimId || !payment.purchaseId) return false;
    return (
      (payment.sourceClaimId === order.sourceClaimId &&
        payment.purchaseId === order.purchaseId) ||
      !!group?.retained.has(`${payment.sourceClaimId}:${payment.purchaseId}`)
    );
  };
}

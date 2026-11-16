import { restorePurchaseValues } from "~/server/domains/financial-transaction/repo/purchase-event-records";
import { recordSubject, type ColumnRef, type Pure } from "~/server/kernel/api";

function decidedValues(
  c: Pure,
  target: ColumnRef,
  id: string,
  values: Parameters<Pure["record"]>[2],
  provenance: Record<string, string>,
) {
  const desired = { ...values };
  for (const [field, decision] of c.assignments(
    recordSubject(target.entity ?? target.name, id),
  )) {
    if (!target.columns.includes(field)) continue;
    Object.assign(
      desired,
      restorePurchaseValues({
        [field]: decision.kind === "none" ? null : decision.value,
      }),
    );
    provenance[field] = decision.id;
  }
  const references = {
    vendorId: "vendor",
    vendorAccountId: "vendorAccount",
    purchaserOverrideId: "ledgerParty",
    defaultProjectId: "project",
    projectId: "project",
    spendingCategoryId: "spendingCategory",
    productId: "product",
    purchaseId: "purchase",
    transactionId: "financialTransaction",
    expenseId: "expense",
    ledgerPartyId: "ledgerParty",
  } as const;
  for (const [field, entity] of Object.entries(references)) {
    const reference = desired[field];
    if (typeof reference === "string")
      desired[field] = c.reference(entity, reference);
  }
  if ("productId" in desired && !desired.productId)
    desired.productQuantity = null;
  return desired;
}

export function recordPurchaseValue(
  c: Pure,
  target: ColumnRef,
  naturalKey: string,
  values: Parameters<Pure["record"]>[2],
  provenance: Record<string, string> = {},
  authored = false,
) {
  const identity = c.identity(target, naturalKey);
  const desired = decidedValues(c, target, identity.id, values, provenance);
  return c.record(target, naturalKey, desired, { provenance, authored });
}

/** A source refusal retains records while still applying explicit member field decisions. */
export function retainPurchaseValue(
  c: Pure,
  target: ColumnRef,
  naturalKey: string,
) {
  const identity = c.identity(target, naturalKey);
  if (c.existing(target).includes(naturalKey)) {
    const provenance: Record<string, string> = {};
    const values = decidedValues(c, target, identity.id, {}, provenance);
    if (Object.keys(values).length)
      c.patch(target, identity.id, values, { provenance });
  }
  c.retire(target, naturalKey, "keep");
}

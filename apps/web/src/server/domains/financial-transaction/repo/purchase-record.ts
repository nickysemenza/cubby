import { restorePurchaseValues } from "~/server/domains/financial-transaction/repo/purchase-event-records";
import { recordSubject, type ColumnRef, type Pure } from "~/server/kernel/api";

export function recordPurchaseValue(
  c: Pure,
  target: ColumnRef,
  naturalKey: string,
  values: Parameters<Pure["record"]>[2],
  provenance: Record<string, string> = {},
  authored = false,
) {
  const identity = c.identity(target, naturalKey);
  const desired = { ...values };
  for (const [field, decision] of c.assignments(
    recordSubject(target.entity ?? target.name, identity.id),
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
  if ("productId" in desired && !desired.productId) desired.productQuantity = null;
  return c.record(target, naturalKey, desired, { provenance, authored });
}

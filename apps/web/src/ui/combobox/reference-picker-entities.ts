import type { PickerEntity } from "./combobox-types";

/**
 * Manifest reference targets edited with an assignment picker. Multi-value
 * and media relations intentionally keep their dedicated controls. A leaf
 * module: entity display reads it without importing the picker search stack.
 */
const referencePickerEntities = new Set<PickerEntity>([
  "cookbook",
  "ingredient",
  "location",
  "product",
  "productCategory",
  "spendingCategory",
  "recipe",
  "project",
  "task",
  "vendor",
  "financialAccount",
  "purchase",
  "ledgerParty",
  "plant",
  "planting",
  "vendorAccount",
]);

export const isReferencePickerEntity = (
  entity: string,
): entity is PickerEntity => {
  // SAFETY: Set membership is the runtime proof that this arbitrary string is
  // one of the closed PickerEntity literals.
  return referencePickerEntities.has(entity as PickerEntity);
};

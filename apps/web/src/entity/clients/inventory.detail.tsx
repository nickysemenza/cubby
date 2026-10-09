import { InventoryRecordExpenseAction } from "~/entity/detail-field-renderers/inventory-expense";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const inventoryDetailHooks = defineDetailHooks("inventory", {
  headerActions: InventoryRecordExpenseAction,
});

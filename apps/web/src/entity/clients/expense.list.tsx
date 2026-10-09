import { expenseListSlots } from "~/app/expenses/list-slots";
import { defineListHooks } from "~/entity/entity-list/list-hooks";

export const expenseListHooks = defineListHooks("expense", {
  slots: expenseListSlots,
});

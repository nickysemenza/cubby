/**
 * The `fields` scope's kernel module: the field Ask, the one `fields`
 * reconciler, and the machinery capability of every authored entity that
 * declares AI fill-in. The money lane's entities (Purchase, Expense,
 * FinancialTransaction) declare their own capability with their owning scope
 * and `fields: true`.
 */
import { defineModule } from "~/server/kernel/api";

import { fieldAsk } from "./ask";
import { fieldsCapabilities, fieldsReconciler } from "./reconciler";

const MONEY_LANE_ENTITIES = new Set([
  "purchase",
  "expense",
  "financialTransaction",
]);

export const fieldsKernelModule = defineModule({
  name: "fields",
  asks: [fieldAsk],
  reconcilers: [fieldsReconciler()],
  machinery: fieldsCapabilities(MONEY_LANE_ENTITIES),
});

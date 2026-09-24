import { locationTypeValues } from "@cubby/shared";
import { COST_TYPE_LABELS, costTypeValues } from "../expense-fields.js";
import {
  EXPENSE_LINE_BASIS_LABELS,
  EXPENSE_LINE_KIND_LABELS,
  expenseLineBasisValues,
  expenseLineKindValues,
} from "../expense-line-kind.js";
import {
  LEDGER_PARTY_KIND_LABELS,
  ledgerPartyKindValues,
} from "../ledger-party-fields.js";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  mealKindValues,
  mealTypeValues,
} from "../meal-classification.js";
import {
  PROJECT_STATUS_LABELS,
  projectKindValues,
  projectStatusValues,
} from "../project-fields.js";
import {
  TASK_STATUS_LABELS,
  TRADE_LABELS,
  taskStatusValues,
  tradeValues,
} from "../task-fields.js";

const labeled = <Value extends string>(
  values: readonly Value[],
  labels: Record<Value, string>,
) => values.map((value) => ({ value, label: labels[value] }));

/** Text-only select labels shared by generated web and Apple controls. Rich browser icons and
 * colors can decorate these values without defining another wording source. */
export const selectControlOptions = {
  locationType: labeled(locationTypeValues, {
    house: "house",
    room: "room",
    area: "area",
    bed: "bed",
    planter: "planter",
    bag: "bag",
    box: "box",
    shelf: "shelf",
    table: "table",
    drawer: "drawer",
    cart: "cart",
    cabinet: "cabinet",
  }),
  mealType: labeled(mealTypeValues, MEAL_TYPE_LABELS),
  mealKind: labeled(mealKindValues, MEAL_KIND_LABELS),
  ledgerPartyKind: labeled(ledgerPartyKindValues, LEDGER_PARTY_KIND_LABELS),
  projectStatus: labeled(projectStatusValues, PROJECT_STATUS_LABELS),
  projectKind: labeled(projectKindValues, {
    furniture: "Furniture",
    workshop: "Workshop",
    household: "Household",
    renovation: "Renovation",
    garden: "Garden",
    trip: "Trip",
  }),
  taskStatus: labeled(taskStatusValues, TASK_STATUS_LABELS),
  trade: labeled(tradeValues, TRADE_LABELS),
  expenseLineKind: labeled(expenseLineKindValues, EXPENSE_LINE_KIND_LABELS),
  expenseLineBasis: labeled(expenseLineBasisValues, EXPENSE_LINE_BASIS_LABELS),
  costType: labeled(costTypeValues, COST_TYPE_LABELS),
} as const;

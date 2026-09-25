import { locationTypeValues } from "@cubby/shared/location-type-theme";
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
  colors?: Record<Value, string>,
) =>
  values.map((value) =>
    colors
      ? { value, label: labels[value], color: colors[value] }
      : { value, label: labels[value] },
  );

/**
 * Select labels shared by generated web and Apple controls, plus the web
 * swatch each value tints its pill with (a CSS custom property; the Apple
 * catalog renders value/label only). Rich browser icons can decorate these
 * values without defining another wording source.
 */
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
  // `cooked` is the overwhelming default, so tone is spent on the exceptions:
  // eat-out kinds share the accent (money left the house).
  mealKind: labeled(mealKindValues, MEAL_KIND_LABELS, {
    cooked: "var(--slate)",
    leftovers: "var(--slate)",
    eating_out: "var(--primary)",
    takeout: "var(--primary)",
    other: "var(--slate)",
  }),
  ledgerPartyKind: labeled(ledgerPartyKindValues, LEDGER_PARTY_KIND_LABELS, {
    member: "var(--slate)",
    guest: "var(--slate)",
    household: "var(--primary)",
  }),
  // Same ink the status charts use, so the cell dot, the picklist swatch and
  // the dashboard series agree.
  projectStatus: labeled(projectStatusValues, PROJECT_STATUS_LABELS, {
    planning: "var(--chart-5)",
    not_started: "var(--chart-neutral)",
    in_progress: "var(--chart-1)",
    done: "var(--chart-positive)",
  }),
  projectKind: labeled(projectKindValues, {
    furniture: "Furniture",
    workshop: "Workshop",
    household: "Household",
    renovation: "Renovation",
    garden: "Garden",
    trip: "Trip",
  }),
  taskStatus: labeled(taskStatusValues, TASK_STATUS_LABELS, {
    not_started: "var(--chart-neutral)",
    later: "var(--chart-2)",
    in_progress: "var(--chart-1)",
    blocked: "var(--chart-negative)",
    done: "var(--chart-positive)",
  }),
  trade: labeled(tradeValues, TRADE_LABELS),
  expenseLineKind: labeled(expenseLineKindValues, EXPENSE_LINE_KIND_LABELS, {
    principal: "var(--slate)",
    tax: "var(--slate)",
    shipping: "var(--slate)",
    discount: "var(--positive)",
    fee: "var(--warning)",
    tip: "var(--plum)",
    other_adjustment: "var(--slate)",
  }),
  expenseLineBasis: labeled(expenseLineBasisValues, EXPENSE_LINE_BASIS_LABELS, {
    item_line: "var(--slate)",
    allocation: "var(--plum)",
  }),
  // The chip twin of the cost-type chart fills.
  costType: labeled(costTypeValues, COST_TYPE_LABELS, {
    materials: "var(--chart-1)",
    tools: "var(--chart-5)",
    services: "var(--chart-2)",
  }),
} as const;

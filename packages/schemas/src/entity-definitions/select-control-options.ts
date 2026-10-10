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
import { PRODUCT_KIND_LABELS, productKindValues } from "../product-fields.js";
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
  descriptions?: Record<Value, string>,
) =>
  values.map((value) => {
    if (colors && descriptions)
      return {
        value,
        label: labels[value],
        color: colors[value],
        description: descriptions[value],
      };
    if (colors) return { value, label: labels[value], color: colors[value] };
    if (descriptions)
      return { value, label: labels[value], description: descriptions[value] };
    return { value, label: labels[value] };
  });

const expenseLineKindDescriptions = {
  principal: "The main item or service purchased",
  tax: "Sales tax or other tax charges",
  shipping: "Shipping, delivery, or freight charges",
  discount: "Discounts, coupons, or promotional reductions",
  fee: "Processing, handling, or service fees",
  tip: "Tips or gratuity",
  other_adjustment: "Other receipt adjustments that don't fit above",
} satisfies Record<(typeof expenseLineKindValues)[number], string>;

/**
 * Labels and optional color overrides shared by web and Apple. The compiler
 * completes uncolored choices through the shared enum palette; browser icons
 * decorate these values without defining another wording or color source.
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
    furniture: "furniture",
  }),
  mealType: labeled(mealTypeValues, MEAL_TYPE_LABELS),
  mealKind: labeled(mealKindValues, MEAL_KIND_LABELS, {
    cooked: "var(--brand-domain-cook)",
    leftovers: "var(--brand-domain-pantry)",
    eating_out: "var(--brand-domain-finance)",
    takeout: "var(--brand-domain-plan)",
    other: "var(--slate)",
  }),
  ledgerPartyKind: labeled(ledgerPartyKindValues, LEDGER_PARTY_KIND_LABELS, {
    member: "var(--brand-domain-house)",
    guest: "var(--brand-domain-plan)",
    household: "var(--brand-domain-pantry)",
  }),
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
    later: "var(--warning)",
    in_progress: "var(--chart-1)",
    blocked: "var(--chart-negative)",
    done: "var(--chart-positive)",
  }),
  trade: labeled(tradeValues, TRADE_LABELS),
  productKind: labeled(productKindValues, PRODUCT_KIND_LABELS),
  expenseLineKind: labeled(
    expenseLineKindValues,
    EXPENSE_LINE_KIND_LABELS,
    {
      principal: "var(--slate)",
      tax: "var(--slate)",
      shipping: "var(--slate)",
      discount: "var(--positive)",
      fee: "var(--warning)",
      tip: "var(--plum)",
      other_adjustment: "var(--slate)",
    },
    expenseLineKindDescriptions,
  ),
  expenseLineBasis: labeled(expenseLineBasisValues, EXPENSE_LINE_BASIS_LABELS, {
    item_line: "var(--slate)",
    allocation: "var(--plum)",
  }),
  costType: labeled(costTypeValues, COST_TYPE_LABELS, {
    materials: "var(--chart-1)",
    tools: "var(--chart-5)",
    services: "var(--chart-2)",
  }),
} as const;

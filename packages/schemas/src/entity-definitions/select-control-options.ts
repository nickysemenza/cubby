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

const location_typeDescriptions = {
  house: "The complete household or property: Home",
  room: "Large spaces in a building: workshop, garage, kitchen, office, bedroom, basement, attic",
  area: "Zones or sections within rooms: workbench area, cutting station, charging station, reading nook",
  shelf:
    "Horizontal storage surfaces: top shelf, shelf 3, wall shelf, closet shelf",
  cabinet:
    "Enclosed storage with doors: tool cabinet, kitchen cabinet, medicine cabinet",
  drawer: "Pull-out compartments: desk drawer, toolbox drawer, kitchen drawer",
  // Crates and totes deliberately have no type of their own any more: they are
  // Products, and a location that is one carries `productId` instead. The
  // classifier should reach for `box` and let the operator attach the SKU.
  box: "Cardboard or plastic boxes, crates and totes: shipping box, storage box, parts box, stackable crate",
  bag: "Fabric or plastic bags: tool bag, shopping bag, parts bag",
  table: "Work surfaces: workbench, desk, countertop, craft table",
  cart: "Mobile storage with wheels: tool cart, utility cart, rolling cart",
  bed: "Outdoor in-ground or raised garden beds: raised bed 1, front garden bed",
  planter:
    "Outdoor pots and containers for growing: patio planter, hanging planter",
  // Never offered to the model: `furniture` is what the server stores for a
  // location that is an instance of a catalogued Product (it needs a productId).
  furniture:
    "A specific catalogued product used as a place: a labelled tote, bin or rack",
};
const tradeDescriptions = {
  planning: "Design, permits, estimates, and pre-work decisions",
  demolition: "Teardown, removal, and job-site cleanup of what's replaced",
  building: "Framing, structural carpentry, and rough construction",
  drywall: "Hanging, taping, mudding, and patching drywall",
  electrical:
    "Wiring, outlets, switches, lighting fixtures, breakers, low-voltage",
  plumbing: "Pipes, fixtures, drains, water heaters, supply and waste lines",
  mechanical: "HVAC, ductwork, furnaces, heat pumps, ventilation",
  cabinetry: "Built-in and freestanding cabinets, cabinet hardware and install",
  countertop: "Countertop fabrication, templating, and installation",
  flooring: "Subfloor, tile, hardwood, carpet, and floor finishing",
  millwork: "Trim, molding, doors, casing, and finish carpentry",
  finishes: "Paint, stain, caulk, and other surface finishing",
  appliances: "Major appliances and furniture selection, delivery, and install",
  landscaping: "Yard work, planting, hardscape, irrigation, fencing",
  logistics: "Moving, hauling, storage, and job-site coordination",
  metalworking: "Welding, fabrication, and metal machining",
  crafts: "Arts, crafts, and small hand-made projects",
  auto: "Vehicle maintenance, repair, and parts",
  other: "Anything that doesn't fit a listed trade",
};
const cost_typeDescriptions = {
  materials:
    "Physical goods consumed by or installed in the work: lumber, fixtures, fasteners, finishes",
  tools: "Equipment bought or rented to do the work, not consumed by it",
  services: "Paid labor, delivery, permits, or other non-material services",
};
const project_kindDescriptions = {
  furniture: "Building or restoring a piece of furniture",
  workshop: "Shop infrastructure, tooling, and workspace setup",
  household: "General household projects not tied to a room renovation",
  renovation: "Renovating or remodeling a room or structure",
  garden: "Outdoor planting, landscaping, and yard projects",
  trip: "Travel and trip planning",
};
const meal_typeDescriptions = {
  breakfast: "Morning meal",
  brunch: "Late-morning meal combining breakfast and lunch",
  lunch: "Midday meal",
  snack: "A small bite between meals",
  dinner: "Evening meal",
  dessert: "A sweet course, usually after dinner",
};
const meal_kindDescriptions = {
  cooked: "Cooked at home from a recipe",
  leftovers: "Reheated food from an earlier meal",
  eating_out: "Eaten at a restaurant",
  takeout: "Ordered for pickup or delivery",
  other: "Doesn't fit a listed kind",
};
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
  locationType: labeled(
    locationTypeValues,
    {
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
    },
    undefined,
    location_typeDescriptions,
  ),
  mealType: labeled(
    mealTypeValues,
    MEAL_TYPE_LABELS,
    undefined,
    meal_typeDescriptions,
  ),
  mealKind: labeled(
    mealKindValues,
    MEAL_KIND_LABELS,
    {
      cooked: "var(--brand-domain-cook)",
      leftovers: "var(--brand-domain-pantry)",
      eating_out: "var(--brand-domain-finance)",
      takeout: "var(--brand-domain-plan)",
      other: "var(--slate)",
    },
    meal_kindDescriptions,
  ),
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
  projectKind: labeled(
    projectKindValues,
    {
      furniture: "Furniture",
      workshop: "Workshop",
      household: "Household",
      renovation: "Renovation",
      garden: "Garden",
      trip: "Trip",
    },
    undefined,
    project_kindDescriptions,
  ),
  taskStatus: labeled(taskStatusValues, TASK_STATUS_LABELS, {
    not_started: "var(--chart-neutral)",
    later: "var(--warning)",
    in_progress: "var(--chart-1)",
    blocked: "var(--chart-negative)",
    done: "var(--chart-positive)",
  }),
  trade: labeled(tradeValues, TRADE_LABELS, undefined, tradeDescriptions),
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
  costType: labeled(
    costTypeValues,
    COST_TYPE_LABELS,
    {
      materials: "var(--chart-1)",
      tools: "var(--chart-5)",
      services: "var(--chart-2)",
    },
    cost_typeDescriptions,
  ),
} as const;

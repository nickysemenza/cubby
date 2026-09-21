/**
 * Enum vocabularies for every decision-tier classification: one description
 * per value (the Jev choice roster's label) and one rules paragraph per
 * field. `satisfies Record<Enum, string>` makes a missing value a build
 * failure instead of a silent `undefined` in the prompt.
 *
 * `CATEGORY_*`/`LOCATION_TYPE_*` moved here from `clients/ai.ts`, which still
 * imports `CATEGORY_DESCRIPTIONS` for the product-identification prompt.
 * Every other vocabulary here backs a `FIELD_SUGGEST_REGISTRY` enum entry
 * (`server/ai/field-suggest/registry.ts`) instead of a bespoke `AiClient`
 * method.
 */
import type { CostType } from "@cubby/schemas/expense-fields";
import type { LocationType } from "@cubby/schemas/location";
import type { MealKind, MealType } from "@cubby/schemas/meal-classification";
import type { ProjectKind } from "@cubby/schemas/project-fields";
import type { Trade } from "@cubby/schemas/task-fields";

// Location type descriptions for the LLM to understand what each type means
// Using `satisfies` to ensure all types have descriptions (build fails if one is missing)
export const LOCATION_TYPE_DESCRIPTIONS = {
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
} satisfies Record<LocationType, string>;

/** The location-type rules; the types themselves are the Jev choices. */
export const LOCATION_TYPE_RULES = `You are a location classification assistant. Given a location name, determine the most appropriate location type.

Rules:
1. Look for keywords in the name that indicate the type (e.g., "shelf" in name suggests shelf type)
2. Consider the hierarchy: rooms contain areas, areas contain shelves/cabinets/drawers, etc.
3. For ambiguous names, consider the most likely physical form
4. Names with numbers often indicate shelves or drawers (e.g., "Shelf 3", "Drawer 2")
5. Names mentioning "workbench" or "station" are typically areas or tables`;

export const TRADE_DESCRIPTIONS = {
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
} satisfies Record<Trade, string>;

export const TRADE_RULES = `You are a home-project trade classification assistant. Given a task or expense name and its available context, determine the most appropriate trade.

Rules:
1. Match the physical work being described, not the room it happens in.
2. A product or vendor name is a strong signal: electrical supply vendors imply "electrical", lumber implies "building".
3. Prefer the most specific trade that fits over "other".
4. "planning" is for pre-work (design, permits, estimates), not the work itself.`;

export const COST_TYPE_DESCRIPTIONS = {
  materials:
    "Physical goods consumed by or installed in the work: lumber, fixtures, fasteners, finishes",
  tools: "Equipment bought or rented to do the work, not consumed by it",
  services: "Paid labor, delivery, permits, or other non-material services",
} satisfies Record<CostType, string>;

export const COST_TYPE_RULES = `You are a project-expense classification assistant. Given an expense name and its available context, determine the most appropriate cost type.

Rules:
1. A consumed or installed physical good is "materials".
2. Equipment that outlives the job and isn't consumed by it is "tools".
3. Paid labor, delivery fees, permits, and other non-material charges are "services".`;

export const PROJECT_KIND_DESCRIPTIONS = {
  furniture: "Building or restoring a piece of furniture",
  workshop: "Shop infrastructure, tooling, and workspace setup",
  household: "General household projects not tied to a room renovation",
  renovation: "Renovating or remodeling a room or structure",
  garden: "Outdoor planting, landscaping, and yard projects",
  trip: "Travel and trip planning",
} satisfies Record<ProjectKind, string>;

export const PROJECT_KIND_RULES = `You are a project classification assistant. Given a project name and notes, determine the most appropriate kind.

Rules:
1. Match the primary subject of the project, not incidental tasks within it.
2. A room or structure name (kitchen, deck, garage) usually indicates "renovation".
3. A single object being built or fixed usually indicates "furniture".`;

export const MEAL_TYPE_DESCRIPTIONS = {
  breakfast: "Morning meal",
  brunch: "Late-morning meal combining breakfast and lunch",
  lunch: "Midday meal",
  snack: "A small bite between meals",
  dinner: "Evening meal",
  dessert: "A sweet course, usually after dinner",
} satisfies Record<MealType, string>;

export const MEAL_TYPE_RULES = `You are a meal-planning classification assistant. Given a meal name, determine which eating occasion of the day it is.

Rules:
1. Use the name's timing and dish cues (e.g., "pancakes" suggests breakfast, "birthday cake" suggests dessert).
2. When the name gives no timing cue, prefer "dinner" — the most common unslotted meal.`;

export const MEAL_KIND_DESCRIPTIONS = {
  cooked: "Cooked at home from a recipe",
  leftovers: "Reheated food from an earlier meal",
  eating_out: "Eaten at a restaurant",
  takeout: "Ordered for pickup or delivery",
  other: "Doesn't fit a listed kind",
} satisfies Record<MealKind, string>;

export const MEAL_KIND_RULES = `You are a meal-planning classification assistant. Given a meal name, determine how the meal is eaten.

Rules:
1. A named dish with no restaurant/delivery cue is "cooked".
2. "leftovers" only when the name says so explicitly.
3. Restaurant or delivery-service names indicate "eating_out" or "takeout" respectively.`;

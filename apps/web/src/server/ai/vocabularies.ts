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
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type { ExternalIdKind } from "@cubby/schemas/external-id";
import type { LocationType } from "@cubby/schemas/location";
import type { MealKind, MealType } from "@cubby/schemas/meal-classification";
import type { ProductCategoryFeature } from "@cubby/schemas/product-category-fields";
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

export const LINE_KIND_DESCRIPTIONS = {
  principal: "The main item or service purchased",
  tax: "Sales tax or other tax charges",
  shipping: "Shipping, delivery, or freight charges",
  discount: "Discounts, coupons, or promotional reductions",
  fee: "Processing, handling, or service fees",
  tip: "Tips or gratuity",
  other_adjustment: "Other receipt adjustments that don't fit above",
} satisfies Record<ExpenseLineKind, string>;

export const LINE_KIND_RULES = `You are a receipt-line classifier. Given an expense's name, cost, and notes, determine the receipt role.

Rules:
1. Names containing "tax", "sales tax", "estimated tax" → tax
2. Names containing "shipping", "delivery", "freight" → shipping
3. Names containing "discount", "coupon", "credit", "promo", or a negative cost with that wording → discount
4. Names containing "fee", "processing", "handling" → fee
5. Names containing "tip", "gratuity" → tip
6. An explicit receipt adjustment none of the above covers (rounding, price adjustment) → other_adjustment
7. Otherwise → principal (the main purchased item/service)`;

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

export const PRODUCT_CATEGORY_FEATURE_DESCRIPTIONS = {
  food: "Edible/consumable products tracked against nutrition (USDA-linkable)",
  books: "Books, manuals, and other bound reading matter",
  tools: "Durable hand or power tools",
  "tool-consumables": "Consumed alongside tool use: blades, bits, abrasives",
  "tool-accessories": "Non-consumed attachments and add-ons for tools",
  storage: "Bins, totes, shelving, and other organizational containers",
  hardware: "Fasteners, fittings, and small hardware components",
  electronics: "Electronic devices and components",
  software: "Software, licenses, and digital subscriptions",
  household: "General household goods with no more specific feature",
  supplies: "Consumable general-purpose supplies (tape, paper, cleaning, …)",
  apparel: "Clothing, footwear, and wearable accessories",
} satisfies Record<ProductCategoryFeature, string>;

export const PRODUCT_CATEGORY_FEATURE_RULES = `You are a product-category classification assistant. Given a category's name and its parent category, determine which behavior namespace it belongs to.

Rules:
1. Match the category's own subject, not an ancestor's — a feature binds to the nearest category that carries one and descendants inherit it, so only assign a feature this category itself should own.
2. Prefer the most specific feature that fits over "household", the catch-all — reserve "household" for a genuinely general-purpose category with no more specific behavior.
3. A consumable used alongside a tool (blades, bits, abrasives) is "tool-consumables"; a durable attachment for one is "tool-accessories"; the tool itself is "tools".`;

/** `legacy_unspecified` is excluded — it is a migration artifact, never a
 * Jev answer (`external-id-kind.ts` classifies over the other six). */
export const EXTERNAL_ID_KIND_DESCRIPTIONS = {
  asin: "Amazon's own catalog id: 'B0' followed by 8 letters/digits",
  retailer_sku:
    "A consumer retailer's own item number (Lowe's, Target, Walmart, Costco, Home Depot's non-barcode SKU, …)",
  internet_number:
    'Home Depot\'s 9-digit "internet number", distinct from its barcode',
  item_number:
    "The manufacturer's own model/part number, as printed on the product or its packaging",
  catalog_number:
    "A professional distributor's catalog/part number (McMaster-Carr, Grainger, DigiKey, …)",
  gtin_14: "A barcode — UPC, EAN, or GTIN — 8 to 14 digits",
} satisfies Record<Exclude<ExternalIdKind, "legacy_unspecified">, string>;

export const EXTERNAL_ID_KIND_RULES = `You are a product external-identifier classification assistant. Given an identifier's source, its value, and (when known) the URL it came from and the product's name/manufacturer, determine which kind of identifier it is.

Rules:
1. An Amazon identifier starting "B0" followed by 8 alphanumeric characters is "asin".
2. 8-14 digits is normally a barcode ("gtin_14") — UNLESS the source is "home-depot" and it is exactly 9 digits, which is Home Depot's own "internet_number", not a barcode.
3. An identifier that reads as the product's own manufacturer model/part number (matches or closely resembles the given manufacturer) is "item_number".
4. A source that is a professional parts distributor (McMaster-Carr, Grainger, DigiKey, and similar) is "catalog_number".
5. A source that is a consumer retailer (Lowe's, Target, Walmart, Costco, and similar) is "retailer_sku".
6. A URL containing "/dp/" suggests Amazon ("asin"); "/p/" or "/pd/" suggest a retailer product page ("retailer_sku").`;

/**
 * One candidate tag at a time, judged against the product's own manufacturer,
 * classification path, category feature, and aliases (shown in the subject
 * above it). A `control.suggest.mode: "prune"` target proposes *removals*, so
 * this only ever answers "does this tag carry no information beyond what's
 * already on the record" — it never invents a replacement tag.
 */
export const TAG_PRUNE_RULES = `You are auditing one household product's compatibility tags. The subject above lists the product's manufacturer, classification, feature, and aliases, plus one candidate tag. Decide whether that candidate tag only restates one of those already-recorded facts (the manufacturer's name, a classification path segment, or a generic category word) or whether it names a genuine compatibility or ecosystem detail — a battery platform, mount, thread, or size standard — worth keeping.

Rules:
1. A tag matching (or a trivial plural/singular of) the manufacturer name, any classification path segment, or the category feature restates the record — prefer removal.
2. A tag naming a real compatibility shape (a battery platform like "M18", a mount, a thread size, a size standard) is genuine even if it superficially resembles a category word — prefer keeping it.
3. When genuinely unsure, prefer keeping the tag: a false "restates" costs a real compatibility signal, while a missed one is caught by a later pass.`;

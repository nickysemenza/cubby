import {
  type CategorySuggestion,
  categorySuggestionSchema,
  type LocationTypeSuggestion,
  locationTypeSuggestionSchema,
} from "@cubby/schemas/ai";
import { type LocationType, locationType } from "@cubby/schemas/location";
import {
  type ProductCategory,
  productCategoryValues,
} from "@cubby/schemas/product";
import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { env } from "~/env";

// Category descriptions for the LLM to understand what each category means
// Using `satisfies` to ensure all categories have descriptions (build fails if one is missing)
const CATEGORY_DESCRIPTIONS = {
  food: "Consumable food items: flour, olive oil, canned tomatoes, spices, meat, produce, beverages",
  tools:
    "Power and hand tools: drills, saws, grinders, screwdrivers, wrenches, measuring tools",
  "tool-consumables":
    "Consumable items used with tools: grinding discs, drill bits, sandpaper, saw blades, router bits",
  "tool-accessories":
    "Non-consumable tool add-ons: jigs, fixtures, guides, router tables, dust collection attachments",
  storage:
    "Organization and storage: toolboxes, systainers, packout, bags, bins, shelving units",
  hardware:
    "Fasteners and fittings: screws, nails, bolts, nuts, washers, hinges, brackets",
  electronics:
    "Electronic devices and components: raspberry pi, arduino, cables, monitors, adapters, sensors",
  household:
    "Home items: furniture, cookware, appliances, decor, cleaning equipment, linens",
  supplies:
    "General consumable supplies: cleaning products, tape, batteries, glue, lubricants, rags",
} satisfies Record<ProductCategory, string>;

function buildCategorySystemPrompt(): string {
  const categoryList = productCategoryValues
    .map((cat) => `- "${cat}": ${CATEGORY_DESCRIPTIONS[cat]}`)
    .join("\n");

  return `You are a product categorization assistant. Given a product name and manufacturer, determine the most appropriate category.

Available categories:
${categoryList}

Rules:
1. If the product has food-related indicators (like being from a food brand, having nutrition info, being edible), always choose "food"
2. For ambiguous items, consider the primary use case
3. "supplies" is for general consumables that don't fit other categories
4. Be precise: drill bits go in "tool-consumables", not "tools"`;
}

// Location type descriptions for the LLM to understand what each type means
// Using `satisfies` to ensure all types have descriptions (build fails if one is missing)
const LOCATION_TYPE_DESCRIPTIONS = {
  room: "Large spaces in a building: workshop, garage, kitchen, office, bedroom, basement, attic",
  area: "Zones or sections within rooms: workbench area, cutting station, charging station, reading nook",
  shelf:
    "Horizontal storage surfaces: top shelf, shelf 3, wall shelf, closet shelf",
  cabinet:
    "Enclosed storage with doors: tool cabinet, kitchen cabinet, medicine cabinet",
  drawer: "Pull-out compartments: desk drawer, toolbox drawer, kitchen drawer",
  box: "Cardboard or plastic boxes: shipping box, storage box, parts box",
  bag: "Fabric or plastic bags: tool bag, shopping bag, parts bag",
  crate: "Full-size stackable plastic crates",
  "half-crate": "Half-height stackable plastic crates",
  "quarter-crate": "Quarter-height stackable plastic crates",
  "milk-crate": "Standard milk crate size containers",
  "tote-bin": "Large plastic bins with lids for storage",
  table: "Work surfaces: workbench, desk, countertop, craft table",
  cart: "Mobile storage with wheels: tool cart, utility cart, rolling cart",
} satisfies Record<LocationType, string>;

function buildLocationTypeSystemPrompt(): string {
  const typeList = locationType.options
    .map((type) => `- "${type}": ${LOCATION_TYPE_DESCRIPTIONS[type]}`)
    .join("\n");

  return `You are a location classification assistant. Given a location name, determine the most appropriate location type.

Available types:
${typeList}

Rules:
1. Look for keywords in the name that indicate the type (e.g., "shelf" in name suggests shelf type)
2. Consider the hierarchy: rooms contain areas, areas contain shelves/cabinets/drawers, etc.
3. For ambiguous names, consider the most likely physical form
4. Names with numbers often indicate shelves or drawers (e.g., "Shelf 3", "Drawer 2")
5. Names mentioning "workbench" or "station" are typically areas or tables`;
}

export class AnthropicClient {
  private adapter: ReturnType<typeof anthropicText> | null = null;

  constructor(private apiKey: string | undefined) {}

  private getAdapter() {
    if (!this.apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not configured. Add it to your .env file.",
      );
    }
    if (!this.adapter) {
      this.adapter = anthropicText("claude-haiku-4-5", {
        apiKey: this.apiKey,
      });
    }
    return this.adapter;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async suggestCategory(
    productName: string,
    manufacturer: string,
  ): Promise<CategorySuggestion> {
    const adapter = this.getAdapter();

    return chat({
      adapter,
      systemPrompts: [buildCategorySystemPrompt()],
      messages: [
        {
          role: "user",
          content: `Product: "${productName}"
Manufacturer: "${manufacturer}"

Categorize this product and explain your reasoning.`,
        },
      ],
      outputSchema: categorySuggestionSchema,
    });
  }

  async suggestLocationType(
    locationName: string,
  ): Promise<LocationTypeSuggestion> {
    const adapter = this.getAdapter();

    return chat({
      adapter,
      systemPrompts: [buildLocationTypeSystemPrompt()],
      messages: [
        {
          role: "user",
          content: `Location: "${locationName}"

Determine the appropriate type for this location and explain your reasoning.`,
        },
      ],
      outputSchema: locationTypeSuggestionSchema,
    });
  }
}

// Singleton instance - lazy initialized
let anthropicClient: AnthropicClient | null = null;

export function getAnthropicClient(): AnthropicClient {
  if (!anthropicClient) {
    anthropicClient = new AnthropicClient(env.ANTHROPIC_API_KEY);
  }
  return anthropicClient;
}

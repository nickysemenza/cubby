import {
  type CategoryAudit,
  type CategorySuggestion,
  categoryAuditSchema,
  categorySuggestionSchema,
  type DetectedInventory,
  detectedInventorySchema,
  type LocationDescription,
  type LocationTypeSuggestion,
  locationDescriptionSchema,
  locationTypeSuggestionSchema,
  type ParsedSearch,
  type ProductIdentification,
  parsedSearchSchema,
  productIdentificationSchema,
} from "@cubby/schemas/ai";
import { type LocationType, locationType } from "@cubby/schemas/location";
import {
  type ProductCategory,
  productCategoryValues,
} from "@cubby/schemas/product";
import { chat, type ImagePart } from "@tanstack/ai";
import {
  type AnthropicImageMetadata,
  createAnthropicChat,
} from "@tanstack/ai-anthropic";
import { env } from "~/env";

// Cubby's Cloudflare AI Gateway base (no provider suffix). Append the provider
// path: `/anthropic`, `/google-ai-studio/v1beta/openai`, etc. Shared by the
// `@tanstack/ai` adapter below and the cookbook-extraction proxy
// (`~/server/utils/cookbook-llm`) so both route through the same gateway + key.
export const AI_GATEWAY_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/9f10f078d35d86c78dedece2300a6b88/cubby";

// Category descriptions for the LLM to understand what each category means
// Using `satisfies` to ensure all categories have descriptions (build fails if one is missing)
export const CATEGORY_DESCRIPTIONS = {
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

function buildProductIdentificationSystemPrompt(): string {
  const categoryList = productCategoryValues
    .map((cat) => `- "${cat}": ${CATEGORY_DESCRIPTIONS[cat]}`)
    .join("\n");

  return `You are a product identification assistant. Given one or more photos of a product, identify what it is.

Extract:
- "name": the product name WITHOUT the brand (e.g., "packing tape roll", "digital scale")
- "manufacturer": the brand/manufacturer if visible, or "(unspecified)" if not identifiable
- "category": the most appropriate category from the list below, or null if unclear
- "model": the model number if visible on the product/packaging, or null

Available categories:
${categoryList}

Rules:
1. Read any text visible on the product or packaging (labels, brand names, model numbers)
2. If multiple products are visible, identify the most prominent one
3. Be specific with product names but exclude the brand (brand goes in manufacturer)
4. For items you can't clearly identify, use a generic descriptive name
5. Only set model to a value if you can clearly read a model number`;
}

class AnthropicClient {
  private adapter: ReturnType<typeof createAnthropicChat> | null = null;

  constructor(private apiKey: string | undefined) {}

  private getAdapter() {
    if (!this.apiKey) {
      throw new Error(
        "AI_GATEWAY_API_KEY is not configured. Add it to your .env file.",
      );
    }
    if (!this.adapter) {
      this.adapter = createAnthropicChat("claude-haiku-4-5", this.apiKey, {
        baseURL: `${AI_GATEWAY_BASE_URL}/anthropic`,
      });
    }
    return this.adapter;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Expose the shared text adapter so the agent runtime can drive its own
   * tool-calling `chat()` loop without re-constructing the gateway client.
   */
  getTextAdapter() {
    return this.getAdapter();
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

  async describeLocation(
    imageUrls: string[],
    locationName: string,
  ): Promise<LocationDescription> {
    const adapter = this.getAdapter();

    const imageParts: ImagePart<AnthropicImageMetadata>[] = imageUrls.map(
      (url) => ({
        type: "image",
        source: { type: "url", value: url },
      }),
    );

    return chat({
      adapter,
      systemPrompts: [
        "You are a visual inventory assistant. Describe what you see stored in this location. Be concise (2-4 sentences). Identify specific items, brands, and quantities where visible. Don't speculate about items you can't clearly see.",
      ],
      messages: [
        {
          role: "user",
          content: [
            ...imageParts,
            {
              type: "text",
              content: `Describe the contents of this location: "${locationName}"`,
            },
          ],
        },
      ],
      outputSchema: locationDescriptionSchema,
    });
  }

  async detectInventoryItems(
    imageUrls: string[],
    locationName: string,
    existingItems: string[],
  ): Promise<DetectedInventory> {
    const adapter = this.getAdapter();

    const imageParts: ImagePart<AnthropicImageMetadata>[] = imageUrls.map(
      (url) => ({
        type: "image",
        source: { type: "url", value: url },
      }),
    );

    const existingItemsList =
      existingItems.length > 0
        ? `\n\nItems already tracked at this location (avoid duplicates):\n${existingItems.map((i) => `- ${i}`).join("\n")}`
        : "";

    return chat({
      adapter,
      systemPrompts: [
        `You are a visual inventory assistant. Identify distinct products and items visible in the photos. For each item:
- "name": the product name WITHOUT the brand (e.g., "packing tape roll", "digital scale", "tape dispenser")
- "manufacturer": the brand/manufacturer if visible, or "(unspecified)" if not identifiable
- Estimate quantity visible
- Suggest an appropriate unit (e.g., "each", "box", "bag", "can", "bottle")
- For items you can't clearly identify, use the "misc:" prefix in name (e.g., "misc:unidentified cables")
- Only list items you can reasonably identify from the photos`,
      ],
      messages: [
        {
          role: "user",
          content: [
            ...imageParts,
            {
              type: "text",
              content: `Identify inventory items in this location: "${locationName}"${existingItemsList}`,
            },
          ],
        },
      ],
      outputSchema: detectedInventorySchema,
    });
  }
  async identifyProduct(imageUrls: string[]): Promise<ProductIdentification> {
    const adapter = this.getAdapter();

    const imageParts: ImagePart<AnthropicImageMetadata>[] = imageUrls.map(
      (url) => ({
        type: "image",
        source: { type: "url", value: url },
      }),
    );

    return chat({
      adapter,
      systemPrompts: [buildProductIdentificationSystemPrompt()],
      messages: [
        {
          role: "user",
          content: [
            ...imageParts,
            {
              type: "text",
              content:
                "Identify this product from the photo(s). Determine the product name, manufacturer, category, and model number if visible.",
            },
          ],
        },
      ],
      outputSchema: productIdentificationSchema,
    });
  }

  async auditCategories(
    products: Array<{
      name: string;
      manufacturer: string;
      category: string | null;
    }>,
    existingCategories: Record<string, string>,
  ): Promise<CategoryAudit> {
    const adapter = this.getAdapter();

    const categoryList = Object.entries(existingCategories)
      .map(([cat, desc]) => `- "${cat}": ${desc}`)
      .join("\n");

    const productList = products
      .map(
        (p) =>
          `- ${p.name} (${p.manufacturer}) [${p.category ?? "uncategorized"}]`,
      )
      .join("\n");

    return chat({
      adapter,
      systemPrompts: [
        `You are a product catalog analyst. Given a list of products and the current category definitions, identify gaps — clusters of products that would benefit from a new category.

Current categories:
${categoryList}

Rules:
1. Only suggest new categories if there is a meaningful cluster of products (at least 3) that don't fit well into existing categories
2. Don't suggest categories that heavily overlap with existing ones
3. Use lowercase kebab-case for category names (e.g., "automotive", "craft-supplies")
4. If the current categories cover the catalog well, return an empty suggestions array
5. For each suggestion, list existing product names that would move to the new category`,
      ],
      messages: [
        {
          role: "user",
          content: `Review these ${products.length} products and suggest any missing categories:\n\n${productList}`,
        },
      ],
      outputSchema: categoryAuditSchema,
    });
  }

  async parseSearchQuery(
    query: string,
    locationNames: string[],
  ): Promise<ParsedSearch> {
    const adapter = this.getAdapter();

    const locationList =
      locationNames.length > 0
        ? `\n\nKnown locations in the system:\n${locationNames.map((n) => `- ${n}`).join("\n")}`
        : "";

    return chat({
      adapter,
      systemPrompts: [
        `You are an inventory search assistant. Parse natural language queries into structured search filters.

Extract:
- "productName": the product or item the user is looking for (null if not specified)
- "locationName": the location the user is asking about (null if not specified)
- "interpretation": a short human-readable summary of what you understood (e.g., "Looking for canned tomatoes across all locations")

Rules:
1. Match location names against the known locations list when possible
2. If the user mentions a location not in the list, use their text as-is
3. Strip filler words like "where are", "find me", "show me", "do I have"
4. For product names, keep the essential search terms (e.g., "canned tomatoes" not "the canned tomatoes")
5. Use singular forms for product names (e.g., "nailer" not "nailers", "tomato" not "tomatoes") since products are stored in singular form${locationList}`,
      ],
      messages: [
        {
          role: "user",
          content: query,
        },
      ],
      outputSchema: parsedSearchSchema,
    });
  }
}

// Singleton instance - lazy initialized
let anthropicClient: AnthropicClient | null = null;

export function getAnthropicClient(): AnthropicClient {
  if (!anthropicClient) {
    anthropicClient = new AnthropicClient(env.AI_GATEWAY_API_KEY);
  }
  return anthropicClient;
}

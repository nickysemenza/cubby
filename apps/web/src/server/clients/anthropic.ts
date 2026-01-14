import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { env } from "~/env";
import {
  type CategorySuggestion,
  categorySuggestionSchema,
} from "~/schemas/ai";
import { type ProductCategory, productCategoryValues } from "~/schemas/product";

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

function buildSystemPrompt(): string {
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
      systemPrompts: [buildSystemPrompt()],
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
}

// Singleton instance - lazy initialized
let anthropicClient: AnthropicClient | null = null;

export function getAnthropicClient(): AnthropicClient {
  if (!anthropicClient) {
    anthropicClient = new AnthropicClient(env.ANTHROPIC_API_KEY);
  }
  return anthropicClient;
}

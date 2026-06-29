import type { Amount } from "@cubby/schemas/codec";
import { z } from "zod";

const nullableText = z.string().nullish();
const nullableTextList = z.array(nullableText).nullish();

const cleanPart = (value: z.infer<typeof nullableText>): string | null => {
  const text = value?.trim();
  return text ? text.replace(/\s+/g, " ") : null;
};

const cleanList = (values: z.infer<typeof nullableTextList>): string[] =>
  (values ?? []).flatMap((value) => {
    const cleaned = cleanPart(value);
    return cleaned ? [cleaned] : [];
  });

const field = (
  label: string,
  value: z.infer<typeof nullableText>,
): string | null => {
  const cleaned = cleanPart(value);
  return cleaned ? `${label}: ${cleaned}` : null;
};

const listField = (
  label: string,
  values: z.infer<typeof nullableTextList>,
): string | null => {
  const cleaned = cleanList(values);
  return cleaned.length > 0 ? `${label}: ${cleaned.join(", ")}` : null;
};

const joinFields = (parts: Array<string | null | undefined>): string =>
  parts.flatMap((part) => (part ? [part] : [])).join("\n");

const productSearchTextInputSchema = z.object({
  name: z.string(),
  manufacturer: nullableText,
  category: nullableText,
  model: nullableText,
  upc: nullableText,
  notes: nullableText,
  aliases: nullableTextList,
});
type ProductSearchTextInput = z.infer<typeof productSearchTextInputSchema>;

export function buildProductEmbeddingText(product: ProductSearchTextInput) {
  const parsed = productSearchTextInputSchema.parse(product);
  return joinFields([
    field("product", parsed.name),
    field("manufacturer", parsed.manufacturer),
    field("category", parsed.category),
    field("model", parsed.model),
    field("upc", parsed.upc),
    listField("aliases", parsed.aliases),
    field("notes", parsed.notes),
  ]);
}

const locationSearchTextInputSchema = z.object({
  name: z.string(),
  type: nullableText,
  parentPath: nullableText,
  aiDescription: nullableText,
  aliases: nullableTextList,
});
type LocationSearchTextInput = z.infer<typeof locationSearchTextInputSchema>;

export function buildLocationEmbeddingText(location: LocationSearchTextInput) {
  const parsed = locationSearchTextInputSchema.parse(location);
  return joinFields([
    field("location", parsed.name),
    field("type", parsed.type),
    field("path", parsed.parentPath),
    listField("aliases", parsed.aliases),
    field("ai description", parsed.aiDescription),
  ]);
}

const ingredientSearchTextInputSchema = z.object({
  name: z.string(),
  aliases: nullableTextList,
});
type IngredientSearchTextInput = z.infer<
  typeof ingredientSearchTextInputSchema
>;

export function buildIngredientEmbeddingText(
  ingredient: IngredientSearchTextInput,
) {
  const parsed = ingredientSearchTextInputSchema.parse(ingredient);
  return joinFields([
    field("ingredient", parsed.name),
    listField("aliases", parsed.aliases),
  ]);
}

const recipeSearchTextInputSchema = z.object({
  name: z.string(),
  tags: nullableTextList,
  notes: nullableText,
  ingredientNames: nullableTextList,
});
type RecipeSearchTextInput = z.infer<typeof recipeSearchTextInputSchema>;

export function buildRecipeEmbeddingText(recipe: RecipeSearchTextInput) {
  const parsed = recipeSearchTextInputSchema.parse(recipe);
  return joinFields([
    field("recipe", parsed.name),
    listField("tags", parsed.tags),
    listField("ingredients", parsed.ingredientNames),
    field("notes", parsed.notes),
  ]);
}

const inventorySearchTextInputSchema = z.object({
  productText: z.string(),
  locationPath: nullableText,
  amount: z.custom<Amount>().nullable().optional(),
});
type InventorySearchTextInput = z.infer<typeof inventorySearchTextInputSchema>;

const amountToText = (amount: Amount | null | undefined): string | null => {
  if (!amount) return null;
  return `${amount.value} ${amount.unit}`.trim();
};

export function buildInventoryEmbeddingText(entry: InventorySearchTextInput) {
  const parsed = inventorySearchTextInputSchema.parse(entry);
  return joinFields([
    parsed.productText,
    field("location", parsed.locationPath),
    field("amount", amountToText(parsed.amount)),
  ]);
}

export function normalizeSearchText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

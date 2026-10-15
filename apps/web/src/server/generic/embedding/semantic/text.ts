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
  /** Preserved in lexical SearchDocument keywords, deliberately not semantic text. */
  gtins: nullableTextList,
  /** Household context can distinguish otherwise-identical products. */
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
    listField("aliases", parsed.aliases),
    field("notes", parsed.notes),
  ]);
}

const wishSearchTextInputSchema = z.object({
  name: z.string(),
  notes: nullableText,
  candidateTerms: nullableTextList,
});

export function buildWishEmbeddingText(
  wish: z.infer<typeof wishSearchTextInputSchema>,
) {
  const parsed = wishSearchTextInputSchema.parse(wish);
  return joinFields([
    field("tool wish", parsed.name),
    listField("tool candidates", parsed.candidateTerms),
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

const cookbookSearchTextInputSchema = z.object({
  name: z.string(),
  author: nullableTextList,
  subjects: nullableTextList,
  sourceLabel: nullableText,
});
type CookbookSearchTextInput = z.infer<typeof cookbookSearchTextInputSchema>;

// Deliberately the book's OWN metadata only — no recipe titles. Folding the
// contents in would make every recipe rename/delete a cookbook-embedding
// fan-out, for a book whose identity is already its title + author + subjects.
export function buildCookbookEmbeddingText(cookbook: CookbookSearchTextInput) {
  const parsed = cookbookSearchTextInputSchema.parse(cookbook);
  return joinFields([
    field("cookbook", parsed.name),
    listField("authors", parsed.author),
    listField("subjects", parsed.subjects),
    field("source", parsed.sourceLabel),
  ]);
}

const mealSearchTextInputSchema = z.object({
  name: nullableText,
  date: nullableText,
  mealType: nullableText,
  mealKind: nullableText,
  recipeNames: nullableTextList,
});
type MealSearchTextInput = z.infer<typeof mealSearchTextInputSchema>;

export function buildMealEmbeddingText(meal: MealSearchTextInput) {
  const parsed = mealSearchTextInputSchema.parse(meal);
  return joinFields([
    field("meal", parsed.name),
    field("date", parsed.date),
    field("type", parsed.mealType),
    // Only the exceptional kinds. "cooked" is true of nearly every meal, so
    // embedding it adds a constant to every vector and distinguishes nothing.
    field("kind", parsed.mealKind === "cooked" ? null : parsed.mealKind),
    listField("recipes", parsed.recipeNames),
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

const projectSearchTextInputSchema = z.object({
  name: z.string(),
  status: nullableText,
  kind: nullableText,
  locations: nullableTextList,
  notes: nullableText,
});
type ProjectSearchTextInput = z.infer<typeof projectSearchTextInputSchema>;

export function buildProjectEmbeddingText(project: ProjectSearchTextInput) {
  const parsed = projectSearchTextInputSchema.parse(project);
  return joinFields([
    field("project", parsed.name),
    field("status", parsed.status),
    field("kind", parsed.kind),
    listField("locations", parsed.locations),
    field("notes", parsed.notes),
  ]);
}

const taskSearchTextInputSchema = z.object({
  name: z.string(),
  status: nullableText,
  trade: nullableText,
  projectName: nullableText,
  subjectProductName: nullableText,
});
type TaskSearchTextInput = z.infer<typeof taskSearchTextInputSchema>;

export function buildTaskEmbeddingText(task: TaskSearchTextInput) {
  const parsed = taskSearchTextInputSchema.parse(task);
  return joinFields([
    field("task", parsed.name),
    field("status", parsed.status),
    field("trade", parsed.trade),
    field("project", parsed.projectName),
    field("product", parsed.subjectProductName),
  ]);
}

const expenseSearchTextInputSchema = z.object({
  name: z.string(),
  lineKind: nullableText,
  costType: nullableText,
  trade: nullableText,
  notes: nullableText,
  projectName: nullableText,
  vendorName: nullableText,
  orderId: nullableText,
});
type ExpenseSearchTextInput = z.infer<typeof expenseSearchTextInputSchema>;

export function buildExpenseEmbeddingText(expense: ExpenseSearchTextInput) {
  const parsed = expenseSearchTextInputSchema.parse(expense);
  return joinFields([
    field("expense", parsed.name),
    field("line kind", parsed.lineKind),
    field("cost type", parsed.costType),
    field("trade", parsed.trade),
    field("project", parsed.projectName),
    field("vendor", parsed.vendorName),
    field("order", parsed.orderId),
    field("notes", parsed.notes),
  ]);
}

const vendorSearchTextInputSchema = z.object({
  name: z.string(),
  website: nullableText,
  notes: nullableText,
});

export function buildVendorEmbeddingText(
  vendor: z.infer<typeof vendorSearchTextInputSchema>,
) {
  const parsed = vendorSearchTextInputSchema.parse(vendor);
  return joinFields([
    field("vendor", parsed.name),
    field("website", parsed.website),
    field("notes", parsed.notes),
  ]);
}

const purchaseSearchTextInputSchema = z.object({
  vendorName: z.string(),
  orderId: nullableText,
  displayLabel: nullableText,
  date: nullableText,
  notes: nullableText,
});

export function buildPurchaseEmbeddingText(
  purchase: z.infer<typeof purchaseSearchTextInputSchema>,
) {
  const parsed = purchaseSearchTextInputSchema.parse(purchase);
  return joinFields([
    field("purchase vendor", parsed.vendorName),
    field("order", parsed.orderId),
    field("display label", parsed.displayLabel),
    field("date", parsed.date),
    field("notes", parsed.notes),
  ]);
}

const financialAccountSearchTextInputSchema = z.object({
  name: z.string(),
  identityTerms: nullableTextList,
  sourceAliasTerms: nullableTextList,
  notes: nullableText,
});

export function buildFinancialAccountEmbeddingText(
  account: z.infer<typeof financialAccountSearchTextInputSchema>,
) {
  const parsed = financialAccountSearchTextInputSchema.parse(account);
  return joinFields([
    field("financial account", parsed.name),
    listField("identity", parsed.identityTerms),
    listField("source aliases", parsed.sourceAliasTerms),
    field("notes", parsed.notes),
  ]);
}

const financialTransactionSearchTextInputSchema = z.object({
  merchant: nullableText,
  rawDescription: nullableText,
  sourceCategory: nullableText,
  sourceRefTerms: nullableTextList,
  notes: nullableText,
  accountName: z.string(),
  vendorName: nullableText,
  orderId: nullableText,
  kind: z.string(),
  status: z.string(),
  transactionDate: nullableText,
  postedDate: nullableText,
});

export function buildFinancialTransactionEmbeddingText(
  transaction: z.infer<typeof financialTransactionSearchTextInputSchema>,
) {
  const parsed = financialTransactionSearchTextInputSchema.parse(transaction);
  return joinFields([
    field("financial transaction", parsed.merchant),
    field("description", parsed.rawDescription),
    field("category", parsed.sourceCategory),
    listField("source references", parsed.sourceRefTerms),
    field("account", parsed.accountName),
    field("vendor", parsed.vendorName),
    field("order", parsed.orderId),
    field("kind", parsed.kind),
    field("status", parsed.status),
    field("transaction date", parsed.transactionDate),
    field("posted date", parsed.postedDate),
    field("notes", parsed.notes),
  ]);
}

const plantSearchTextInputSchema = z.object({
  displayName: z.string(),
  latinName: nullableText,
  verdict: nullableText,
  notes: nullableText,
});

export function buildPlantEmbeddingText(
  plant: z.infer<typeof plantSearchTextInputSchema>,
) {
  const parsed = plantSearchTextInputSchema.parse(plant);
  return joinFields([
    field("plant", parsed.displayName),
    field("latin name", parsed.latinName),
    field("verdict", parsed.verdict),
    field("notes", parsed.notes),
  ]);
}

const plantingSearchTextInputSchema = z.object({
  plantName: z.string(),
  status: nullableText,
  locationName: nullableText,
  notes: nullableText,
});

export function buildPlantingEmbeddingText(
  planting: z.infer<typeof plantingSearchTextInputSchema>,
) {
  const parsed = plantingSearchTextInputSchema.parse(planting);
  return joinFields([
    field("planting", parsed.plantName),
    field("status", parsed.status),
    field("location", parsed.locationName),
    field("notes", parsed.notes),
  ]);
}

const gardenEntrySearchTextInputSchema = z.object({
  kindLabel: z.string(),
  observedOn: z.string(),
  locationName: z.string(),
  plantingName: nullableText,
  note: nullableText,
  harvestAmount: nullableText,
});

export function buildGardenEntryEmbeddingText(
  entry: z.infer<typeof gardenEntrySearchTextInputSchema>,
) {
  const parsed = gardenEntrySearchTextInputSchema.parse(entry);
  return joinFields([
    field("garden entry", `${parsed.kindLabel} · ${parsed.observedOn}`),
    field("location", parsed.locationName),
    field("planting", parsed.plantingName),
    field("harvest amount", parsed.harvestAmount),
    field("notes", parsed.note),
  ]);
}

export function normalizeSearchText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

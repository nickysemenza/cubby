import type { AiSelectionSpec } from "~/server/ai/selection";
import type { MergeShortlistEntry } from "~/server/services/ai-enrichment/merge-shortlist";
import type { UsdaShortlistEntry } from "~/server/services/ai-enrichment/usda-shortlist";

const USDA_MATCH_RULES = `You map a recipe ingredient to the single best USDA FoodData Central entry, for nutrition and cost.

Rules:
1. Prefer the generic whole-food form. Prefer sr_legacy_food over foundation_food.
2. Choose a branded_food ONLY when the ingredient is itself a brand/specific product (e.g. "Biscoff cookies", "Oreos").
3. Decline if nothing suitable is shown.`;

export const usdaFoodSpec: Omit<
  AiSelectionSpec<UsdaShortlistEntry>,
  "feature"
> = {
  rules: USDA_MATCH_RULES,
  idOf: (entry) => String(entry.fdcId),
  renderLine: (entry) => entry.line,
  maxCandidates: 25,
};

export const usdaMatchSubject = (ingredientName: string) =>
  `Find the best USDA food for the recipe ingredient: "${ingredientName}".`;

const MERGE_RULES = `You decide whether a recipe ingredient is the SAME purchasable item as an existing ingredient, so the two can be merged (deduplicated).

Merge ONLY when they are the same thing you would buy — synonyms, alternate names, or spelling/case variants. Examples to merge: scallion = green onion; cilantro = coriander (leaf); garbanzo beans = chickpeas; confectioners' sugar = powdered sugar.

NEVER merge distinct variants a cook treats differently: light vs dark brown sugar; whole vs 2% milk; salted vs unsalted butter; fresh vs dried herbs.

Each candidate is shown as "id [N products]: name". Prefer a target that already has products — the merge inherits them.

Decline when unsure. A wrong merge is destructive, so be conservative.`;

export const ingredientMergeSpec: Omit<
  AiSelectionSpec<MergeShortlistEntry>,
  "feature"
> = {
  rules: MERGE_RULES,
  idOf: (entry) => entry.id,
  renderLine: (entry) =>
    `${entry.id} [${entry.productCount} products]: ${entry.name}`,
  maxCandidates: 20,
};

export const ingredientMergeSubject = (name: string) =>
  `Is the recipe ingredient "${name}" the same purchasable item as an existing ingredient?`;

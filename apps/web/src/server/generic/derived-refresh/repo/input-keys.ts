import { refreshInputKinds } from "./freshness";

const refreshContextTables = [
  "EntityLink",
  "EntityAttachment",
  "EntityExternalId",
  "AiAnalysis",
  "FinancialTransactionAllocation",
  "ExpenseAttribution",
  "ProductUnitMapping",
  "RecipeSection",
  "RecipeSectionIngredient",
  "MealRecipe",
  "MealFoodEntry",
  "ImportSourceProduct",
  "ImportSourceOrder",
  "OrderMail",
  "OrderMailEvent",
  "StatementRow",
] as const;

export const refreshInputKeys = (kind: string) => [
  ...refreshInputKinds(kind).map((input) => `kind:${input}`),
  ...refreshContextTables.map((table) => `context:${table}`),
  "context:AssessmentState",
];

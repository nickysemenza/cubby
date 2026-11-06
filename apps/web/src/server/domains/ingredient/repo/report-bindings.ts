import { ingredientSellersSummary } from "~/server/domains/ingredient/repo/report-summary";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";
import { ingredientRecipeUsagesReport } from "~/server/generic/entity-report/repo/records";

export const reportBindings = {
  "ingredient.sellers": reportBuilder(ingredientSellersSummary),
  "ingredient.recipe-usages": reportBuilder(ingredientRecipeUsagesReport),
};

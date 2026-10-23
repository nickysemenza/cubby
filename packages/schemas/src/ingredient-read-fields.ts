import { z } from "zod";
import { productNutritionDisplay } from "./product-read-fields";
import { recipeUsageOut } from "./recipe-fields";
import { displayImagesField } from "./display-images";
import {
  productWithMappingsOut,
  productWithMappingsAndFoodOut,
} from "./product-output-fields";
import { recipeTopLevel, recipeRefOut } from "./recipe-shared";
import { productShortcode } from "./identifier-fields";
export const ingredientNutritionProductOut = z.object({
  productId: productShortcode,
  name: z.string(),
  brandName: z.string().nullable(),
  display: productNutritionDisplay,
});
export type IngredientNutritionProductOut = z.infer<
  typeof ingredientNutritionProductOut
>;

export function ingredientReadSchemas<S extends z.ZodRawShape>(
  base: z.ZodObject<S>,
) {
  const list = base.extend({
    displayImages: displayImagesField,
    product: z.array(productWithMappingsOut),
    appearsInRecipes: z.array(recipeRefOut),
    ownRecipeCount: z.number().int(),
  });
  const detail = base.extend({
    recipe: recipeTopLevel.nullable(),
    recipeUsages: z.array(recipeUsageOut),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.array(productWithMappingsAndFoodOut),
    nutritionProduct: ingredientNutritionProductOut.nullable(),
  });
  return { output: base, list, detail };
}

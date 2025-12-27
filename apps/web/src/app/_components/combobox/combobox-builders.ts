import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import type { IngredientWithRecipesAndProductOut } from "~/schemas/combo";
import type {
  IngredientId,
  LocationId,
  ProductId,
  RecipeId,
} from "~/schemas/identifiers";
import type { LocationOut } from "~/schemas/location";
import type { ProductTopLevelOut } from "~/schemas/product";
import type { RecipeOut } from "~/schemas/recipe";

export const buildProductComboboxItem = (
  product: ProductTopLevelOut,
): ComboboxItem<ProductId> => ({
  id: product.id,
  name: `${product.name} (${product.manufacturer})`,
});

export const buildLocationComboboxItem = (
  location: LocationOut,
): ComboboxItem<LocationId> => ({
  id: location.id,
  name: `${location.name} (${location.type})`,
});

export const buildIngredientComboboxItem = (
  location: IngredientWithRecipesAndProductOut,
): ComboboxItem<IngredientId> => ({
  id: location.id,
  name: `${location.name}`,
});

export const buildRecipeComboboxItem = (
  recipe: RecipeOut,
): ComboboxItem<RecipeId> => ({
  id: recipe.id as RecipeId,
  name: recipe.name,
});

import type { IngredientWithRecipesAndProductOut } from "@cubby/schemas/combo";
import type {
  IngredientId,
  LocationId,
  ProductId,
  RecipeId,
} from "@cubby/schemas/identifiers";
import type { LocationOut } from "@cubby/schemas/location";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import type { RecipeOut } from "@cubby/schemas/recipe";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { LocationIcon } from "~/app/_components/locations/location-icons";

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
  icon: (
    <LocationIcon
      type={location.type}
      size={14}
      className="text-muted-foreground"
    />
  ),
});

export const buildIngredientComboboxItem = (
  location: IngredientWithRecipesAndProductOut,
): ComboboxItem<IngredientId> => ({
  id: location.id,
  name: `${location.name}`,
  aliases: location.aliases ?? [],
});

export const buildRecipeComboboxItem = (
  recipe: RecipeOut,
): ComboboxItem<RecipeId> => ({
  id: recipe.id,
  name: recipe.name,
});

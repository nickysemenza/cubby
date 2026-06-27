import type {
  IngredientId,
  LocationId,
  ProductId,
  RecipeId,
} from "@cubby/schemas/identifiers";
import type { LocationOut } from "@cubby/schemas/location";
import type { ProductPickerItemOut } from "@cubby/schemas/product-responses";
import type { RecipeListItem } from "@cubby/schemas/recipe-responses";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { LocationIcon } from "~/app/_components/locations/location-icons";

export const buildProductComboboxItem = (
  product: ProductPickerItemOut,
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

export const buildIngredientComboboxItem = (ingredient: {
  id: IngredientId;
  name: string;
  aliases?: string[] | null;
}): ComboboxItem<IngredientId> => ({
  id: ingredient.id,
  name: ingredient.name,
  aliases: ingredient.aliases ?? [],
});

export const buildRecipeComboboxItem = (
  recipe: RecipeListItem,
): ComboboxItem<RecipeId> => ({
  id: recipe.id,
  name: recipe.name,
});

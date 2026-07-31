import type {
  IngredientId,
  LocationId,
  ProductId,
  ProjectShortcode,
  RecipeId,
  TaskShortcode,
} from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { LocationIcon } from "~/app/_components/locations/location-icons";

// Builders take minimal structural shapes (not the full *Out types) so both
// picker results and list-row relation summaries pass without casts.
export const buildProductComboboxItem = (product: {
  id: ProductId;
  name: string;
  manufacturer: string;
}): ComboboxItem<ProductId> => ({
  id: product.id,
  name: `${product.name} (${product.manufacturer})`,
});

export const buildLocationComboboxItem = (location: {
  id: LocationId;
  name: string;
  type: LocationType;
}): ComboboxItem<LocationId> => ({
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

export const buildRecipeComboboxItem = (recipe: {
  id: RecipeId;
  name: string;
}): ComboboxItem<RecipeId> => ({
  id: recipe.id,
  name: recipe.name,
});

export const buildProjectComboboxItem = (project: {
  id: ProjectShortcode;
  name: string;
}): ComboboxItem<ProjectShortcode> => ({
  id: project.id,
  name: project.name,
});

export const buildTaskComboboxItem = (task: {
  id: TaskShortcode;
  name: string;
}): ComboboxItem<TaskShortcode> => ({
  id: task.id,
  name: task.name,
});

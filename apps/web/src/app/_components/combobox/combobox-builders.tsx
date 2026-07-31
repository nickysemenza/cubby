import type {
  IngredientShortcode,
  LocationShortcode,
  ProjectShortcode,
  RecipeShortcode,
  TaskShortcode,
} from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { LocationIcon } from "~/app/_components/locations/location-icons";

export const buildLocationComboboxItem = (location: {
  id: LocationShortcode;
  name: string;
  type: LocationType;
}): ComboboxItem<LocationShortcode> => ({
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
  id: IngredientShortcode;
  name: string;
  aliases?: string[] | null;
}): ComboboxItem<IngredientShortcode> => ({
  id: ingredient.id,
  name: ingredient.name,
  aliases: ingredient.aliases ?? [],
});

export const buildRecipeComboboxItem = (recipe: {
  id: RecipeShortcode;
  name: string;
}): ComboboxItem<RecipeShortcode> => ({
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

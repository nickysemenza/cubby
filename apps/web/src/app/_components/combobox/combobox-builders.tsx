import type {
  IngredientShortcode,
  LocationShortcode,
  ProductShortcode,
  ProjectShortcode,
  RecipeShortcode,
  TaskShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { VendorMark } from "~/components/entity/vendor-cell";
import { EntityIcon } from "~/entities/entities";

// Builders take minimal structural shapes (not the full *Out types) so both
// picker results and list-row relation summaries pass without casts.
export const buildProductComboboxItem = (product: {
  id: ProductShortcode;
  name: string;
  manufacturer: string;
  aliases?: string[] | null;
}): ComboboxItem<ProductShortcode> => ({
  id: product.id,
  shortcode: product.id,
  name: product.name,
  aliases: product.aliases ?? [],
  secondary: product.manufacturer,
  icon: <EntityIcon entity="product" size={14} colored />,
});

export const buildLocationComboboxItem = (location: {
  id: LocationShortcode;
  name: string;
  type: LocationType;
  aliases?: string[] | null;
}): ComboboxItem<LocationShortcode> => ({
  id: location.id,
  shortcode: location.id,
  name: location.name,
  aliases: location.aliases ?? [],
  secondary: location.type,
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
  shortcode: ingredient.id,
  name: ingredient.name,
  aliases: ingredient.aliases ?? [],
  icon: <EntityIcon entity="ingredient" size={14} colored />,
});

export const buildRecipeComboboxItem = (recipe: {
  id: RecipeShortcode;
  name: string;
}): ComboboxItem<RecipeShortcode> => ({
  id: recipe.id,
  shortcode: recipe.id,
  name: recipe.name,
  icon: <EntityIcon entity="recipe" size={14} colored />,
});

export const buildProjectComboboxItem = (project: {
  id: ProjectShortcode;
  name: string;
}): ComboboxItem<ProjectShortcode> => ({
  id: project.id,
  shortcode: project.id,
  name: project.name,
  icon: <EntityIcon entity="project" size={14} colored />,
});

export const buildTaskComboboxItem = (task: {
  id: TaskShortcode;
  name: string;
}): ComboboxItem<TaskShortcode> => ({
  id: task.id,
  shortcode: task.id,
  name: task.name,
  icon: <EntityIcon entity="task" size={14} colored />,
});

export const buildVendorNameComboboxItem = (vendor: {
  id: VendorShortcode;
  name: string;
}): ComboboxItem<string> => ({
  id: vendor.name,
  shortcode: vendor.id,
  name: vendor.name,
  icon: <VendorMark vendor={vendor.name} vendorId={vendor.id} />,
});

export const buildVendorShortcodeComboboxItem = (vendor: {
  id: VendorShortcode;
  name: string;
}): ComboboxItem<VendorShortcode> => ({
  id: vendor.id,
  shortcode: vendor.id,
  name: vendor.name,
  icon: <VendorMark vendor={vendor.name} vendorId={vendor.id} />,
});

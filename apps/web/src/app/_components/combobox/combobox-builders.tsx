import type {
  IngredientShortcode,
  LocationShortcode,
  ProductShortcode,
  ProjectShortcode,
  RecipeShortcode,
  TaskShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { locationToSegments } from "~/app/_components/locations/location-breadcrumb";
import { LocationPickerThumb } from "~/app/_components/locations/location-picker-thumb";
import { ProjectMark } from "~/app/projects/project-mark";
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

/**
 * `ancestors` and `coverImage` are optional because three shapes feed this
 * builder: the search endpoint (both present), a by-shortcode read (ancestors
 * derived from its nested parent chain, see `locationToSegments`), and a
 * freshly-created location (neither — it has no parent chain loaded yet).
 */
export const buildLocationComboboxItem = (location: {
  id: LocationShortcode;
  name: string;
  type: LocationType;
  aliases?: string[] | null;
  ancestors?: Array<{ name: string }> | null;
  coverImage?: { url: string } | null;
}): ComboboxItem<LocationShortcode> => ({
  id: location.id,
  shortcode: location.id,
  name: location.name,
  aliases: location.aliases ?? [],
  secondary: location.type,
  detail: location.ancestors?.length
    ? location.ancestors.map((ancestor) => ancestor.name).join(" › ")
    : undefined,
  icon: (
    <LocationPickerThumb
      imageUrl={location.coverImage?.url}
      type={location.type}
    />
  ),
});

/**
 * Same row, built from a detail-shaped location — a by-shortcode read or a
 * just-created one. Those carry the ancestor chain nested under `parent` and
 * the full image list, rather than the flat `ancestors` / `coverImage` the
 * search endpoint returns.
 */
export const buildLocationComboboxItemFromDetail = (
  location: InfLocation,
): ComboboxItem<LocationShortcode> =>
  buildLocationComboboxItem({
    ...location,
    // `locationToSegments` is root→leaf and includes the location itself.
    ancestors: locationToSegments(location).slice(0, -1),
    coverImage: location.images.find(isDisplayableImageFile) ?? null,
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
  icon?: string | null;
}): ComboboxItem<ProjectShortcode> => ({
  id: project.id,
  shortcode: project.id,
  name: project.name,
  icon: <ProjectMark icon={project.icon} />,
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

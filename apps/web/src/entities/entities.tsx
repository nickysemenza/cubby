import type { Entity } from "@cubby/schemas/entity";
import type { CookbookId } from "@cubby/schemas/identifiers";
import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { imageSortableFields } from "@cubby/schemas/image";
import { ingredientSortableFields } from "@cubby/schemas/ingredient";
import { inventorySortableFields } from "@cubby/schemas/inventory";
import { locationSortableFields } from "@cubby/schemas/location";
import { mealSortableFields } from "@cubby/schemas/meal";
import { productSortableFields } from "@cubby/schemas/product";
import {
  projectSortableFields,
  purchaseSortableFields,
  taskSortableFields,
} from "@cubby/schemas/project";
import { recipeSortableFields } from "@cubby/schemas/recipe";
import { usdaFoodSortableFields } from "@cubby/schemas/usda";
import {
  Apple,
  Barcode,
  BookOpen,
  CalendarDays,
  Carrot,
  ChefHat,
  Hammer,
  Image,
  ListChecks,
  type LucideProps,
  MapPin,
  Package,
  ReceiptText,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { ENTITY_ACCENTS } from "./entity-accents";
import type { EntityDefinition } from "./types";

const entityColor = (
  entity: Entity,
  {
    bg,
    text = "text-primary",
    border = "border-l-primary",
  }: { bg: string; text?: string; border?: string },
) => ({
  accent: ENTITY_ACCENTS[entity],
  bg,
  text,
  border,
});

const entityDefinitions = {
  ingredient: {
    label: "Ingredient",
    pluralLabel: "Ingredients",
    basePath: "ingredients",
    lucideIcon: Carrot,
    color: entityColor("ingredient", {
      bg: "bg-warning/20",
      text: "text-accent-foreground",
      border: "border-l-warning",
    }),
    routes: {
      detail: "/ingredients/$id",
      list: "/ingredients",
      new: "/ingredients/new",
    },
    // Note: ingredient uses UnitMappingsTable (different from UnitMappingDisplay),
    // so unit-mappings is handled as a custom section
    detail: { commonSections: ["history"] },
    // Note: ingredient list has custom column order (selection first, createdAt in middle)
    // so we don't use standardColumns and define all columns explicitly
    list: {
      hasUnitMappings: true,
      defaultSort: "createdAt",
      standardColumns: [],
      // appearsInRecipes/product are computed (recipe + product counts), sorted
      // via correlated subqueries in ingredientList (not real columns).
      sortableFields: ingredientSortableFields,
    },
  },
  product: {
    label: "Product",
    pluralLabel: "Products",
    basePath: "products",
    lucideIcon: Barcode,
    color: entityColor("product", { bg: "bg-primary/10" }),
    routes: {
      detail: "/products/$id",
      list: "/products",
      new: "/products/new",
    },
    // Note: product renders unit mappings as a custom section (coverage grid +
    // rows table, like ingredient), so unit-mappings is not a common section.
    detail: { commonSections: ["history"] },
    list: {
      hasUnitMappings: true,
      defaultSort: "createdAt",
      standardColumns: ["image", "name", "createdAt"],
      // `ingredient` and `location` are computed sorts handled explicitly by
      // productList, not physical product columns.
      sortableFields: productSortableFields,
    },
  },
  recipe: {
    label: "Recipe",
    pluralLabel: "Recipes",
    basePath: "recipes",
    lucideIcon: ChefHat,
    color: entityColor("recipe", { bg: "bg-primary/10" }),
    routes: {
      detail: "/recipes/$id",
      list: "/recipes",
      new: "/recipes/new",
    },
    detail: { commonSections: ["images", "history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["image", "name", "createdAt"],
      // costTotal/caloriesTotal live in the `totals` jsonb (not real columns);
      // recipeList sorts them via a jsonb expression. `source` (SourceType+SourceData)
      // and `yield` (→ servings) are also special-cased there. See recipe/crud.recipeList.
      sortableFields: recipeSortableFields,
    },
  },
  cookbook: {
    label: "Cookbook",
    pluralLabel: "Cookbooks",
    basePath: "cookbooks",
    lucideIcon: BookOpen,
    color: entityColor("cookbook", { bg: "bg-primary/10" }),
    // Keyed by FK id (rename-safe); no generic list columns or "new" form
    // (cookbooks are created by EPUB import, not a create form).
    routes: {
      detail: "/cookbooks/$cookbookId",
      list: "/cookbooks",
    },
  },
  location: {
    label: "Location",
    pluralLabel: "Locations",
    basePath: "locations",
    lucideIcon: MapPin,
    color: entityColor("location", {
      bg: "bg-slate/20",
      text: "text-slate",
      border: "border-l-slate",
    }),
    routes: {
      detail: "/locations/$id",
      list: "/locations",
      new: "/locations/new",
    },
    // Note: location needs images in a specific position (before child locations),
    // so we handle it as a custom section and only use history from common
    detail: { commonSections: ["history"] },
    // Note: location list has custom column order (createdAt in middle, view toggle),
    // so we don't use standardColumns and define all columns explicitly
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
      sortableFields: locationSortableFields,
    },
  },
  inventory: {
    label: "Inventory Item",
    pluralLabel: "Inventory",
    basePath: "inventory",
    lucideIcon: Package,
    color: entityColor("inventory", { bg: "bg-primary/10" }),
    routes: {
      detail: "/inventory/$id",
      list: "/inventory",
      new: "/inventory/new",
    },
    // Inventory items have a simple single-section detail page
    detail: { commonSections: ["history"] },
    // Inventory list has custom columns (image from product, amount instead of name)
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
      sortableFields: inventorySortableFields,
    },
  },
  meal: {
    label: "Meal",
    pluralLabel: "Meals",
    basePath: "meals",
    lucideIcon: CalendarDays,
    color: entityColor("meal", {
      bg: "bg-warning/20",
      text: "text-warning",
      border: "border-l-warning",
    }),
    routes: {
      detail: "/meals/$id",
      list: "/meals",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "date",
      standardColumns: [],
      sortableFields: mealSortableFields,
    },
  },
  project: {
    label: "Project",
    pluralLabel: "Projects",
    basePath: "projects",
    lucideIcon: Hammer,
    color: entityColor("project", {
      bg: "bg-plum/15",
      text: "text-plum",
      border: "border-l-plum",
    }),
    // No "new" route — projects are created from a dialog on the list page
    // (mirrors meal), not a dedicated /projects/new form.
    routes: {
      detail: "/projects/$id",
      list: "/projects",
    },
    detail: { commonSections: ["images", "history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name"],
      sortableFields: projectSortableFields,
    },
  },
  task: {
    label: "Task",
    pluralLabel: "Tasks",
    basePath: "tasks",
    lucideIcon: ListChecks,
    color: entityColor("task", {
      bg: "bg-slate/20",
      text: "text-slate",
      border: "border-l-slate",
    }),
    routes: {
      detail: "/tasks/$id",
      list: "/tasks",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name", "createdAt"],
      sortableFields: taskSortableFields,
    },
  },
  purchase: {
    label: "Purchase",
    pluralLabel: "Purchases",
    basePath: "purchases",
    lucideIcon: ReceiptText,
    color: entityColor("purchase", { bg: "bg-primary/10" }),
    routes: {
      detail: "/purchases/$id",
      list: "/purchases",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "date",
      standardColumns: ["name", "createdAt"],
      sortableFields: purchaseSortableFields,
    },
  },
  "usda-food": {
    label: "USDA Food",
    pluralLabel: "USDA Foods",
    basePath: "usda",
    lucideIcon: Apple,
    color: entityColor("usda-food", {
      bg: "bg-positive/15",
      text: "text-positive",
      border: "border-l-positive",
    }),
    routes: {
      detail: "/usda/$id",
      list: "/usda",
      // no "new" - USDA foods are read-only
    },
    // USDA foods are read-only, no detail/list conventions needed
    list: {
      defaultSort: "fdc_id",
      standardColumns: [],
      sortableFields: usdaFoodSortableFields,
    },
  },
  image: {
    label: "Image",
    pluralLabel: "Images",
    basePath: "images",
    lucideIcon: Image,
    color: entityColor("image", {
      bg: "bg-muted",
      text: "text-muted-foreground",
      border: "border-l-muted-foreground",
    }),
    routes: {
      detail: "/images/$id",
      list: "/images",
      // no "new" - images are uploaded, not created via form
    },
    detail: { commonSections: ["history"] },
    // Note: images use 'filename' not 'name', so we define columns explicitly in ImageList
    list: {
      defaultSort: "createdAt",
      standardColumns: ["createdAt"],
      sortableFields: imageSortableFields,
    },
  },
} as const satisfies Record<Entity, EntityDefinition>;

/** Route unions are derived from the definitions so links cannot drift. */
export type EntityDetailRoute =
  (typeof entityDefinitions)[Entity]["routes"]["detail"];
export type EntityListRoute =
  (typeof entityDefinitions)[Entity]["routes"]["list"];
export type EntityNewRoute = {
  [E in Entity]: (typeof entityDefinitions)[E]["routes"] extends {
    new: infer TRoute extends string;
  }
    ? TRoute
    : never;
}[Entity];

export const entities = entityDefinitions as typeof entityDefinitions &
  Record<Entity, EntityDefinition>;

/**
 * Path params for an entity's detail route. Every detail route is keyed `$id`
 * except cookbook, whose route is `/cookbooks/$cookbookId` — so any generic
 * "link to this entity by id" surface (search results, hovercards, the manifest
 * card) must route through here instead of hard-coding `{ id }`.
 */
export const entityDetailParams = (
  entity: Entity,
  id: string,
): { id: string } | { cookbookId: CookbookId } =>
  entity === "cookbook" ? { cookbookId: unsafeCookbookId(id) } : { id };

/** Path-params shape accepted by any entity detail `<Link>`. */
export type EntityDetailParams = ReturnType<typeof entityDetailParams>;

/**
 * Get the list of server-sortable fields for an entity.
 * Used by both repos (for buildOrderBy) and UI (for enableSorting).
 */
export const getSortableFields = (entity: Entity): readonly string[] =>
  entities[entity].list?.sortableFields ?? ["createdAt", "name"];

/**
 * Render an entity's lucide icon. Useful for entities where you need
 * dynamic icon selection based on entity type.
 *
 * Use `colored` prop to apply the entity's text color for visual identification.
 */
export const EntityIcon = ({
  entity,
  colored,
  className,
  ...props
}: { entity: Entity; colored?: boolean } & LucideProps) => {
  const def = entities[entity];
  return (
    <def.lucideIcon
      className={cn(colored && def.color.text, className)}
      {...props}
    />
  );
};

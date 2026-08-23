import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  Apple,
  Barcode,
  BookOpen,
  CalendarDays,
  Carrot,
  ChefHat,
  CreditCard,
  Hammer,
  Heart,
  Image,
  ListChecks,
  type LucideProps,
  MapPin,
  Package,
  Receipt,
  ReceiptText,
  Store,
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
      detail: "/ingredients/$shortcode",
      list: "/ingredients",
      new: "/ingredients/new",
    },
    // Note: ingredient uses UnitMappingsTable (different from UnitMappingDisplay),
    // so unit-mappings is handled as a custom section
    detail: { commonSections: ["history"] },
    // Ingredient supplies its domain columns explicitly; the shared list hook
    // still appends the default-hidden Created/Updated audit pair.
    list: {
      hasUnitMappings: true,
      defaultSort: "createdAt",
      standardColumns: [],
      // appearsInRecipes/product are computed (recipe + product counts), sorted
      // via correlated subqueries in ingredientList (not real columns).
    },
  },
  product: {
    label: "Product",
    pluralLabel: "Products",
    basePath: "products",
    lucideIcon: Barcode,
    color: entityColor("product", { bg: "bg-primary/10" }),
    routes: {
      detail: "/products/$shortcode",
      list: "/products",
      new: "/products/new",
    },
    // Note: product renders unit mappings as a custom section (coverage grid +
    // rows table, like ingredient), so unit-mappings is not a common section.
    detail: { commonSections: ["history"] },
    list: {
      hasUnitMappings: true,
      defaultSort: "createdAt",
      standardColumns: ["image", "name"],
      // `ingredient` and `location` are computed sorts handled explicitly by
      // productList, not physical product columns.
    },
  },
  recipe: {
    label: "Recipe",
    pluralLabel: "Recipes",
    basePath: "recipes",
    lucideIcon: ChefHat,
    color: entityColor("recipe", { bg: "bg-primary/10" }),
    routes: {
      detail: "/recipes/$shortcode",
      list: "/recipes",
      new: "/recipes/new",
    },
    detail: { commonSections: ["images", "history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["image", "name"],
      // costTotal/caloriesTotal live in the `totals` jsonb (not real columns);
      // recipeList sorts them via a jsonb expression. `source` (SourceType+SourceData)
      // and `yield` (→ servings) are also special-cased there. See recipe/crud.recipeList.
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
      detail: "/cookbooks/$shortcode",
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
      detail: "/locations/$shortcode",
      list: "/locations",
      new: "/locations/new",
    },
    // Note: location needs images in a specific position (before child locations),
    // so we handle it as a custom section and only use history from common
    detail: { commonSections: ["history"] },
    // Location supplies its domain columns explicitly; audit dates are shared.
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
    },
  },
  inventory: {
    label: "Inventory Item",
    pluralLabel: "Inventory",
    basePath: "inventory",
    lucideIcon: Package,
    color: entityColor("inventory", { bg: "bg-primary/10" }),
    routes: {
      detail: "/inventory/$shortcode",
      list: "/inventory",
      new: "/inventory/new",
    },
    // Inventory items have a simple single-section detail page
    detail: { commonSections: ["history"] },
    // Inventory list has custom columns (image from product, amount instead of name)
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
    },
  },
  meal: {
    label: "Meal",
    pluralLabel: "Meals",
    basePath: "meals",
    lucideIcon: CalendarDays,
    // Tracks ENTITY_ACCENTS.meal — see the note there for why a meal is no
    // longer amber.
    color: entityColor("meal", {
      bg: "bg-slate/20",
      text: "text-slate",
      border: "border-l-slate",
    }),
    routes: {
      detail: "/meals/$shortcode",
      list: "/meals",
    },
    detail: { commonSections: ["history"] },
    // Date/Name/Recipes/Cost columns are custom (meal-table.tsx) — Name needs
    // `emptyLabel`, which useStandardColumns's automatic "name" column
    // doesn't support. Audit dates are appended for every entity list.
    list: {
      defaultSort: "date",
      standardColumns: [],
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
      detail: "/projects/$shortcode",
      list: "/projects",
    },
    detail: { commonSections: ["images", "history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name"],
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
      detail: "/tasks/$shortcode",
      list: "/tasks",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name"],
    },
  },
  vendor: {
    label: "Vendor",
    pluralLabel: "Vendors",
    basePath: "vendors",
    lucideIcon: Store,
    color: entityColor("vendor", {
      bg: "bg-slate/20",
      text: "text-slate",
      border: "border-l-slate",
    }),
    routes: {
      detail: "/vendors/$shortcode",
      list: "/vendors",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "name",
      standardColumns: ["name"],
    },
  },
  purchase: {
    label: "Purchase",
    pluralLabel: "Purchases",
    basePath: "purchases",
    lucideIcon: Receipt,
    color: entityColor("purchase", { bg: "bg-primary/10" }),
    routes: {
      detail: "/purchases/$shortcode",
      list: "/purchases",
    },
    // A Purchase carries its documents (invoices/receipts), like
    // project's photos — same commonSections shape.
    detail: { commonSections: ["images", "history"] },
    // No `name` column — a purchase's identity is (vendor, orderId, date), not
    // a free-text name, so the list defines its columns explicitly (like location).
    list: {
      defaultSort: "date",
      standardColumns: [],
    },
  },
  expense: {
    label: "Expense",
    pluralLabel: "Expenses",
    basePath: "expenses",
    lucideIcon: ReceiptText,
    color: entityColor("expense", { bg: "bg-primary/10" }),
    routes: {
      detail: "/expenses/$shortcode",
      list: "/expenses",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "date",
      standardColumns: ["name"],
    },
  },
  financialAccount: {
    label: "Financial Account",
    pluralLabel: "Accounts",
    basePath: "financial-accounts",
    lucideIcon: CreditCard,
    color: entityColor("financialAccount", {
      bg: "bg-slate/20",
      text: "text-slate",
      border: "border-l-slate",
    }),
    routes: {
      detail: "/financial-accounts/$shortcode",
      list: "/financial-accounts",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "name",
      standardColumns: [],
    },
  },
  financialTransaction: {
    label: "Financial Transaction",
    pluralLabel: "Transactions",
    basePath: "financial-transactions",
    lucideIcon: CreditCard,
    color: entityColor("financialTransaction", { bg: "bg-primary/10" }),
    routes: {
      detail: "/financial-transactions/$shortcode",
      list: "/financial-transactions",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "transactionDate",
      standardColumns: [],
    },
  },
  wish: {
    label: "Wish",
    pluralLabel: "Wishlist",
    basePath: "wishes",
    lucideIcon: Heart,
    color: entityColor("wish", {
      bg: "bg-plum/15",
      text: "text-plum",
      border: "border-l-plum",
    }),
    routes: {
      detail: "/wishes/$shortcode",
      list: "/wishes",
    },
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name"],
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
      detail: "/images/$shortcode",
      list: "/images",
      // no "new" - images are uploaded, not created via form
    },
    detail: { commonSections: ["history"] },
    // Note: images use 'filename' not 'name', so we define columns explicitly in ImageList
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
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
 * Path params for an entity's detail route.
 *
 * Every shortcode-bearing entity is keyed `$shortcode`, so this is now uniform —
 * the cookbook `$cookbookId` special case died with the uuid routes. It stays a
 * function rather than an inline `{ shortcode }` because it is the single place
 * a generic "link to this entity" surface (search results, hovercards, the
 * manifest card, table name columns) goes through, and keeping the indirection
 * is what would make a future per-entity divergence a one-line change.
 *
 * `usda` is NOT routed through here — it is the one detail route that
 * legitimately keys on something other than a shortcode (an external USDA
 * `fdc_id`). `image` used to be the other exception (no public shortcode);
 * it now mints one like every other entity, so it goes through
 * {@link entityDetailLink} same as anything else.
 */
export const entityDetailParams = (
  shortcode: string,
): { shortcode: string } => ({
  shortcode,
});

/**
 * `to` + `params` for a shortcode-bearing entity's detail route, in one call.
 *
 * The `ShortcodeEntity` parameter is doing real work: `Entity` also covers
 * `usda-food`, whose route is `/usda/$id`, so a lookup widened to `Entity`
 * produces a route union that `{ shortcode }` cannot satisfy. Narrowing here
 * is what lets every generic "link to this entity" surface pass a shortcode
 * without a cast.
 */
export const entityDetailLink = (entity: ShortcodeEntity, shortcode: string) =>
  ({
    to: entities[entity].routes.detail,
    params: entityDetailParams(shortcode),
  }) as const;

/** Path-params shape accepted by any entity detail `<Link>`. */
export type EntityDetailParams = ReturnType<typeof entityDetailParams>;

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

import type { Entity } from "@cubby/schemas/entity";
import type {
  BrowserRoutedEntity,
  ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { displayGtin } from "@cubby/schemas/external-id";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import type { VendorOut } from "@cubby/schemas/vendor";
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
import { purchaseLabel } from "~/lib/purchase-label";
import { cn, formatCurrency } from "~/lib/utils";
import { generatedBrowserRoutes } from "./generated/entity-routes.gen";
import type { EntityColor, EntityDefinition } from "./types";

/**
 * The four inks an entity can wear. `accent` feeds the `--page-accent` /
 * `--row-accent` CSS variables (styles.css) for decorative chrome — the
 * page-hero accent bar, table row-hover/selected bars — while the tailwind
 * trio dresses icon tiles and badges.
 *
 * Warm-Paper Ledger: there is no per-entity warm hue ladder anymore — the live
 * accent is the lone ultramarine (`--primary`), and quieter surfaces fall to
 * the neutral ink-slate. Status semantics (`--positive`/`--warning`) are the
 * only colored exceptions, kept for the entities whose accent encodes state.
 * The two entities that dress against their accent (ingredient, image) spell
 * their color out rather than joining a hue.
 */
const INK = {
  primary: {
    accent: "var(--primary)",
    bg: "bg-primary/10",
    text: "text-primary",
    border: "border-l-primary",
  },
  slate: {
    accent: "var(--slate)",
    bg: "bg-slate/20",
    text: "text-slate",
    border: "border-l-slate",
  },
  plum: {
    accent: "var(--plum)",
    bg: "bg-plum/15",
    text: "text-plum",
    border: "border-l-plum",
  },
  positive: {
    accent: "var(--positive)",
    bg: "bg-positive/15",
    text: "text-positive",
    border: "border-l-positive",
  },
} satisfies Record<string, EntityColor>;

const newRouteExtensions = {
  ingredient: { new: "/ingredients/new" },
  inventory: { new: "/inventory/new" },
  location: { new: "/locations/new" },
  product: { new: "/products/new" },
  recipe: { new: "/recipes/new" },
} as const;

const entityDefinitions = {
  ingredient: {
    label: "Ingredient",
    pluralLabel: "Ingredients",
    ...generatedBrowserRoutes.ingredient,
    lucideIcon: Carrot,
    color: {
      accent: INK.slate.accent,
      bg: "bg-warning/20",
      text: "text-accent-foreground",
      border: "border-l-warning",
    },
    routes: {
      ...generatedBrowserRoutes.ingredient.routes,
      ...newRouteExtensions.ingredient,
    },
    // Note: ingredient uses UnitMappingsTable (different from UnitMappingDisplay),
    // so unit-mappings is handled as a custom section
    detail: { commonSections: ["history"] },
    // appearsInRecipes/product are computed (recipe + product counts), sorted
    // via correlated subqueries in ingredientList (not real columns).
    sortableFields: [
      "createdAt",
      "updatedAt",
      "name",
      "appearsInRecipes",
      "product",
    ],
    // Ingredient supplies its domain columns explicitly; the shared list hook
    // still appends the default-hidden Created/Updated audit pair.
    list: {
      hasUnitMappings: true,
      defaultSort: "createdAt",
      standardColumns: [],
    },
    // The caller supplies a duplicate group in a deterministic order; the
    // first ingredient starts as keeper, with a deliberate picker override.
    mergeable: {
      keeperMode: "ranked",
      rowLabel: (row: { id: string; name: string }) => (
        <span className="truncate">{row.name}</span>
      ),
      copy: {
        title: "Merge ingredients?",
      },
    },
  },
  product: {
    label: "Product",
    pluralLabel: "Products",
    ...generatedBrowserRoutes.product,
    lucideIcon: Barcode,
    color: INK.primary,
    routes: {
      ...generatedBrowserRoutes.product.routes,
      ...newRouteExtensions.product,
    },
    // Note: product renders unit mappings as a custom section (coverage grid +
    // rows table, like ingredient), so unit-mappings is not a common section.
    detail: { commonSections: ["history"] },
    // `ingredient` and `location` are computed sorts handled explicitly by
    // productList, not physical product columns.
    sortableFields: [
      "createdAt",
      "updatedAt",
      "name",
      "manufacturer",
      "model",
      "primaryGtin",
      "category",
      "fdc_id",
      "price",
      "notes",
      "location",
      "ingredient",
      "expenseTotal",
      "expenses",
      "expectedQuantity",
      "quantityVariance",
      "purchaseDate",
      "related:product.projects",
      "related:product.vendors",
      "related:product.purchases",
      "identity_strength",
    ],
    list: {
      hasUnitMappings: true,
      defaultSort: "createdAt",
      standardColumns: ["image", "name"],
    },
    // The detector supplies duplicate rows in a stable order; the first starts
    // as keeper and the picker remains available for an intentional change.
    mergeable: {
      keeperMode: "ranked",
      rowLabel: (row: { id: string; name: string }) => (
        <span className="truncate">{row.name}</span>
      ),
      rowStat: (row: { gtins: string[]; sources: string[] }) => (
        <>
          {row.gtins.length > 0 && (
            <span>UPC {row.gtins.map(displayGtin).join(", ")}</span>
          )}
          <span>
            {row.sources.length > 0
              ? row.sources.join(", ")
              : "no external ids"}
          </span>
        </>
      ),
      copy: {
        title: "Merge products?",
        description:
          "These rows share the same manufacturer part number, split across retailers. Pick which one to keep — the rest merge into it.",
      },
    },
  },
  recipe: {
    label: "Recipe",
    pluralLabel: "Recipes",
    ...generatedBrowserRoutes.recipe,
    lucideIcon: ChefHat,
    color: INK.primary,
    routes: {
      ...generatedBrowserRoutes.recipe.routes,
      ...newRouteExtensions.recipe,
    },
    detail: { commonSections: ["images", "history"] },
    // costTotal/caloriesTotal live in the `totals` jsonb (not real columns);
    // recipeList sorts them via a jsonb expression. `source` (SourceType+SourceData)
    // and `yield` (→ servings) are also special-cased there. See recipe/crud.recipeList.
    sortableFields: [
      "createdAt",
      "updatedAt",
      "name",
      "cookbook",
      "costTotal",
      "caloriesTotal",
      "source",
      "yield",
      "tags",
      "totalMinutes",
    ],
    list: {
      defaultSort: "createdAt",
      standardColumns: ["image", "name"],
    },
  },
  cookbook: {
    label: "Cookbook",
    pluralLabel: "Cookbooks",
    ...generatedBrowserRoutes.cookbook,
    lucideIcon: BookOpen,
    color: INK.primary,
    // Keyed by FK id (rename-safe); no generic list columns or "new" form
    // (cookbooks are created by EPUB import, not a create form).
    sortableFields: [],
  },
  location: {
    label: "Location",
    pluralLabel: "Locations",
    ...generatedBrowserRoutes.location,
    lucideIcon: MapPin,
    color: INK.slate,
    routes: {
      ...generatedBrowserRoutes.location.routes,
      ...newRouteExtensions.location,
    },
    // Note: location needs images in a specific position (before child locations),
    // so we handle it as a custom section and only use history from common
    detail: { commonSections: ["history"] },
    sortableFields: [
      "createdAt",
      "updatedAt",
      "name",
      "type",
      "parent",
      "lastBulkInventory",
      "valuation",
      "inventoryEntries",
    ],
    // Location supplies its domain columns explicitly; audit dates are shared.
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
    },
  },
  inventory: {
    label: "Inventory Item",
    pluralLabel: "Inventory",
    ...generatedBrowserRoutes.inventory,
    lucideIcon: Package,
    color: INK.primary,
    routes: {
      ...generatedBrowserRoutes.inventory.routes,
      ...newRouteExtensions.inventory,
    },
    // Inventory items have a simple single-section detail page
    detail: { commonSections: ["history"] },
    sortableFields: [
      "createdAt",
      "updatedAt",
      "name",
      "product",
      "location",
      "amount",
      "valuation",
      "verifiedAt",
    ],
    // Inventory list has custom columns (image from product, amount instead of name)
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
    },
  },
  meal: {
    label: "Meal",
    pluralLabel: "Meals",
    ...generatedBrowserRoutes.meal,
    lucideIcon: CalendarDays,
    // Neutral, not amber: the status ramp is reserved for entities whose accent
    // encodes state, and a meal's encodes none. Amber is also already spent on
    // overdue/planned expenses inside the same planning calendar, so a meal
    // wearing it read as a warning about nothing.
    color: INK.slate,
    detail: { commonSections: ["history"] },
    sortableFields: ["date", "name", "mealType", "createdAt", "updatedAt"],
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
    ...generatedBrowserRoutes.project,
    lucideIcon: Hammer,
    color: INK.plum,
    // No "new" route — projects are created from a dialog on the list page
    // (mirrors meal), not a dedicated /projects/new form.
    detail: { commonSections: ["images", "history"] },
    sortableFields: [
      "name",
      "status",
      "kind",
      "startDate",
      "costEstimate",
      "createdAt",
      "updatedAt",
    ],
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name"],
    },
  },
  task: {
    label: "Task",
    pluralLabel: "Tasks",
    ...generatedBrowserRoutes.task,
    lucideIcon: ListChecks,
    color: INK.slate,
    detail: { commonSections: ["history"] },
    sortableFields: [
      "name",
      "status",
      "dueDate",
      "trade",
      "project",
      "subjectProduct",
      "createdAt",
      "updatedAt",
    ],
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name"],
    },
  },
  vendor: {
    label: "Vendor",
    pluralLabel: "Vendors",
    ...generatedBrowserRoutes.vendor,
    lucideIcon: Store,
    // A quiet roster, not a live money surface — same neutral as location/task.
    color: INK.slate,
    detail: { commonSections: ["history"] },
    sortableFields: [
      "name",
      "purchaseCount",
      "spend",
      "latestPurchaseDate",
      "createdAt",
      "updatedAt",
    ],
    list: {
      // Open on biggest spenders first: "where did the money go" is the
      // question this roster exists to answer. (It used to be `name`, with the
      // vendor list overriding it page-side — descending name would have
      // landed the roster on Z→A.)
      defaultSort: "spend",
      standardColumns: ["name"],
    },
    // "fixed": the keeper is the vendor being viewed; candidates are every
    // OTHER vendor (mergeVendors has no cross-vendor refusal like
    // mergePurchases' vendor-match check — any two vendors can fold together).
    mergeable: {
      keeperMode: "fixed",
      candidateQuery: (api, _keeper: VendorOut) =>
        api.vendor.list.queryOptions({
          filters: {},
          // Generous relative to the whole roster (~150 vendors), within
          // MAX_PAGE_SIZE — every other vendor is a merge candidate.
          pagination: { pageIndex: 0, pageSize: 200 },
        }),
      rowLabel: (row: VendorOut) => row.name,
      rowStat: (row: VendorOut) =>
        `${row.purchaseCount} purchase${row.purchaseCount === 1 ? "" : "s"} · ${formatCurrency(row.spend)}`,
      copy: {
        title: (keeperLabel) => <>Merge into {keeperLabel}</>,
        description:
          "Pick other vendors to fold in. Their purchases move onto this vendor — any purchases sharing an order id are folded together — and the folded vendors leave the roster. Website and notes carry over only where this vendor has none.",
        emptyTitle: "Nothing to merge",
        emptyDescription: "No other vendors are on file.",
      },
    },
  },
  purchase: {
    label: "Purchase",
    pluralLabel: "Purchases",
    ...generatedBrowserRoutes.purchase,
    lucideIcon: Receipt,
    color: INK.primary,
    // A Purchase carries its documents (invoices/receipts), like
    // project's photos — same commonSections shape.
    detail: { commonSections: ["images", "history"] },
    sortableFields: [
      "orderId",
      "displayLabel",
      "date",
      "statedTotal",
      "vendor",
      "expenseCount",
      "expenseTotal",
      "reconciliationGap",
      "documentCount",
      "createdAt",
      "updatedAt",
    ],
    // No `name` column — a purchase's identity is (vendor, orderId, date), not
    // a free-text name, so the list defines its columns explicitly (like location).
    list: {
      defaultSort: "date",
      standardColumns: [],
    },
    // "fixed": the keeper is the purchase being viewed; candidates are every
    // OTHER purchase from the same vendor (mergePurchases refuses cross-vendor,
    // and separately refuses when both sides carry a non-null order id — that
    // refusal surfaces as the dialog's error toast, not pre-validated here).
    mergeable: {
      keeperMode: "fixed",
      candidateQuery: (api, keeper: PurchaseOut) =>
        api.purchase.list.queryOptions({
          filters: { vendorId: keeper.vendorId },
          // Generous relative to any one vendor's purchase count, within MAX_PAGE_SIZE.
          pagination: { pageIndex: 0, pageSize: 200 },
        }),
      rowLabel: (row: PurchaseOut) => purchaseLabel(row),
      rowStat: (row: PurchaseOut) =>
        `${row.expenseCount} · ${formatCurrency(row.expenseTotal)}`,
      copy: {
        title: (keeperLabel) => <>Merge into {keeperLabel}</>,
        description:
          "Pick other purchases from the same vendor to fold in. Their expenses and documents move onto this purchase; the folded purchases are then deleted.",
        emptyTitle: "Nothing to merge",
        emptyDescription: "This vendor has no other purchases on file.",
        caution:
          "One purchase is one vendor order or receipt event, never a contract — a payment schedule stays as separate purchases. Merge only rows that are genuinely the same transaction.",
      },
    },
  },
  expense: {
    label: "Expense",
    pluralLabel: "Expenses",
    ...generatedBrowserRoutes.expense,
    lucideIcon: ReceiptText,
    color: INK.primary,
    detail: { commonSections: ["history"] },
    sortableFields: [
      "name",
      "cost",
      "lineKind",
      "productQuantity",
      "date",
      "costType",
      "trade",
      "project",
      "product",
      "vendor",
      "orderId",
      "createdAt",
      "updatedAt",
    ],
    list: {
      defaultSort: "date",
      standardColumns: ["name"],
    },
  },
  financialAccount: {
    label: "Financial Account",
    dialogLabel: "Account",
    pluralLabel: "Accounts",
    ...generatedBrowserRoutes.financialAccount,
    lucideIcon: CreditCard,
    color: INK.slate,
    detail: { commonSections: ["history"] },
    sortableFields: [
      "name",
      "provisional",
      "transactionCount",
      "createdAt",
      "updatedAt",
    ],
    list: {
      defaultSort: "name",
      // A name roster reads A→Z; the table's blanket descending default was
      // opening the account list backwards.
      defaultSortDirection: "asc",
      standardColumns: [],
    },
  },
  financialTransaction: {
    label: "Financial Transaction",
    dialogLabel: "Transaction",
    pluralLabel: "Transactions",
    ...generatedBrowserRoutes.financialTransaction,
    lucideIcon: CreditCard,
    color: INK.primary,
    detail: { commonSections: ["history"] },
    sortableFields: [
      "transactionDate",
      "postedDate",
      "amount",
      "merchant",
      "kind",
      "status",
      "createdAt",
      "updatedAt",
    ],
    list: {
      defaultSort: "transactionDate",
      standardColumns: [],
    },
  },
  wish: {
    label: "Wish",
    pluralLabel: "Wishlist",
    ...generatedBrowserRoutes.wish,
    lucideIcon: Heart,
    color: INK.plum,
    detail: { commonSections: ["history"] },
    sortableFields: [
      "name",
      "acquiredAt",
      "priceRange",
      "createdAt",
      "updatedAt",
    ],
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name"],
    },
  },
  "usda-food": {
    label: "USDA Food",
    pluralLabel: "USDA Foods",
    ...generatedBrowserRoutes["usda-food"],
    lucideIcon: Apple,
    color: INK.positive,
    sortableFields: [
      "fdc_id",
      "description",
      "data_type",
      "relevance",
      "linkedProducts",
    ],
    // USDA foods are read-only, no detail/list conventions needed
    list: {
      defaultSort: "fdc_id",
      standardColumns: [],
    },
  },
  image: {
    label: "Image",
    pluralLabel: "Images",
    ...generatedBrowserRoutes.image,
    lucideIcon: Image,
    color: {
      accent: INK.slate.accent,
      bg: "bg-muted",
      text: "text-muted-foreground",
      border: "border-l-muted-foreground",
    },
    detail: { commonSections: ["history"] },
    sortableFields: ["createdAt", "updatedAt", "filename", "size", "status"],
    // Note: images use 'filename' not 'name', so we define columns explicitly in ImageList
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
    },
  },
} as const satisfies Record<BrowserRoutedEntity, EntityDefinition>;

/** Route unions are derived from the definitions so links cannot drift. */
export type EntityDetailRoute =
  (typeof entityDefinitions)[BrowserRoutedEntity]["routes"]["detail"];

/** Browser presentation exists only for entities with browser routes. */
export const entities = entityDefinitions;

export const isBrowserRoutedEntity = (
  entity: Entity,
): entity is BrowserRoutedEntity => entity in entityDefinitions;

/** Presentation metadata for an entity whose browser-route capability is known. */
export const browserEntityDefinition = (
  entity: BrowserRoutedEntity,
): EntityDefinition => entities[entity];

/** Route-less entities have no sort contract to project. */
export const getSortableFields = (entity: Entity): readonly string[] =>
  isBrowserRoutedEntity(entity) ? entities[entity].sortableFields : [];

/**
 * Human-readable labels for generic surfaces that include route-less entities.
 * Routed entities keep their curated UI copy; route-less records deliberately
 * avoid growing a parallel browser registry just to appear in audit tooling.
 */
export const entityLabel = (entity: Entity): string => {
  if (isBrowserRoutedEntity(entity)) return entities[entity].label;
  return entity === "ledgerParty" ? "Ledger party" : "Ledger transfer";
};

/** Concise noun for confirmation dialogs and destructive-action feedback. */
export const entityDialogLabel = (entity: Entity): string =>
  isBrowserRoutedEntity(entity)
    ? (browserEntityDefinition(entity).dialogLabel ?? entities[entity].label)
    : entityLabel(entity);

export const entityPluralLabel = (entity: Entity): string =>
  isBrowserRoutedEntity(entity)
    ? entities[entity].pluralLabel
    : `${entityLabel(entity)} records`;

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
 * `usda` is NOT routed through here — it legitimately keys on an external USDA
 * `fdc_id` rather than a shortcode.
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
export const entityDetailLink = (
  entity: Extract<ShortcodeEntity, BrowserRoutedEntity>,
  shortcode: string,
) =>
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
  if (!isBrowserRoutedEntity(entity)) return null;
  const def = entities[entity];
  return (
    <def.lucideIcon
      className={cn(colored && def.color.text, className)}
      {...props}
    />
  );
};

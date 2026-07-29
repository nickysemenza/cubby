import type { Entity } from "@cubby/schemas/entity";
import {
  unsafeCookbookId,
  unsafeLocationId,
  unsafeProductId,
  unsafeProjectId,
} from "@cubby/schemas/identifiers";
import type { FilterConfig } from "~/app/_components/data-table/columnHelpers";
import { locationTypeOptionsWithTheme } from "~/app/_components/locations/location-icons";
import { productCategoryOptionsWithTheme } from "~/app/_components/products/product-category-icons";
import { tradeOptions } from "~/app/projects/trade-options";
import {
  costTypeOptions,
  dateRangeOptions,
  futureFilterOptions,
  resolveDateRange,
} from "~/app/purchases/purchase-options";
import {
  dueRangeOptions,
  resolveDueRange,
  taskStatusOptions,
} from "~/app/tasks/task-options";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { urlStringParam } from "~/lib/search-params";
import {
  type FilterKind,
  type FilterSpecCore,
  isMultiFilterKind,
  nullableSentinelOptions,
  presenceFilterOptions,
} from "./filters";

/**
 * The filter manifest: what each entity's list table can be filtered by.
 *
 * One entry drives the header filter control, the server filter field, and
 * (via `kind`) how the column's state is shaped. The pure builders that
 * consume it live in `./filters`, kept separate so they're unit-testable.
 *
 * Import direction matters: `useStandardColumns` imports this, so nothing
 * here may import a module that reaches back into the table hooks. That's why
 * `tradeOptions` lives in a leaf module rather than in `app/projects/shared.tsx`.
 */
export interface FilterSpec extends FilterSpecCore {
  /** Full placeholder. `HeaderFilter` shortens it for select controls. */
  placeholder: string;
  /** Static options. Mutually exclusive with `optionsKey`. */
  options?: FilterableComboboxItem[];
  /**
   * Names a runtime option list the page supplies via `filterOptions` — for
   * picklists that come from the server (the project roster, a recipe's tag
   * universe) and so can't be static module data.
   */
  optionsKey?: string;
}

/** The control a kind renders as. */
const filterTypeForKind = (
  kind: FilterKind,
): "text" | "select" | "multiselect" =>
  kind === "text" ? "text" : isMultiFilterKind(kind) ? "multiselect" : "select";

const entityFilters: Partial<Record<Entity, readonly FilterSpec[]>> = {
  purchase: [
    {
      columnId: "name",
      field: "search",
      // `?q=`, not `?name=` — an established link shape (command palette, the
      // "see all in ledger" links), kept working across the URL-sync move.
      urlKey: "q",
      kind: "text",
      placeholder: "Search purchases...",
    },
    {
      columnId: "date",
      kind: "range",
      placeholder: "Filter by date...",
      options: dateRangeOptions,
      expand: resolveDateRange,
    },
    {
      columnId: "costType",
      kind: "multiselect",
      placeholder: "Filter by cost type...",
      options: costTypeOptions,
    },
    {
      columnId: "trade",
      kind: "multiselect",
      placeholder: "Filter by trade...",
      options: tradeOptions,
    },
    {
      columnId: "future",
      kind: "boolean",
      placeholder: "Filter by status...",
      options: futureFilterOptions,
    },
    {
      // The Cost column has no picklist of its own — this only distinguishes
      // recorded vs. not, which is what makes the Unclassified predicate
      // (`trade='other' AND cost IS NULL`) expressible as plain URL state.
      columnId: "cost",
      field: "costPresenceFilter",
      kind: "presence",
      placeholder: "Filter by cost...",
      options: presenceFilterOptions("cost"),
    },
    {
      columnId: "project",
      field: "projectId",
      kind: "idMulti",
      brand: unsafeProjectId,
      placeholder: "Filter by project...",
      optionsKey: "project",
      nullable: { field: "projectPresenceFilter", label: "project" },
    },
    {
      // No column renders this — it's seeded from the URL only (a deep link
      // from a product's detail page). Declared so the builder still maps it.
      columnId: "productId",
      urlOnly: true,
      kind: "id",
      brand: unsafeProductId,
      placeholder: "Filter by product id...",
    },
    {
      // A full product picklist isn't practical (the product universe is
      // unbounded, unlike projects), so this only distinguishes linked vs not.
      columnId: "product",
      field: "productPresenceFilter",
      kind: "presence",
      placeholder: "Filter by product...",
      options: presenceFilterOptions("product"),
    },
    {
      // Free text on the row, but a bounded roster in practice — options come
      // from `purchase.vendorOptions` at runtime, carrying each vendor's brand
      // mark and row count. `(none)` is the where-did-this-come-from worklist;
      // vendor is null on most rows.
      columnId: "vendor",
      kind: "multiselect",
      placeholder: "Filter by vendor...",
      optionsKey: "vendor",
      nullable: { field: "vendorPresenceFilter", label: "vendor" },
    },
    {
      // "none" is the unreconciled worklist — no vendor order id recorded.
      columnId: "orderId",
      field: "orderIdPresenceFilter",
      kind: "presence",
      placeholder: "Filter by order id...",
      options: presenceFilterOptions("order id"),
    },
    {
      // URL-only, like `productId` above — seeded by the "Same Order" section's
      // header badge and the ledger's Order # cell, surfaced as a ScopeChip.
      // Its `columnId` can't be `orderId`: that one is the presence control,
      // and a second spec on the same id would read the same filter slot.
      // Always paired with `vendor` (or `vendor=(none)`) by its callers, since
      // an order id is only unique within a vendor.
      columnId: "orderIdExact",
      urlOnly: true,
      field: "orderId",
      urlKey: "order",
      kind: "id",
      placeholder: "Filter by order id...",
    },
  ],

  task: [
    {
      columnId: "name",
      field: "search",
      kind: "text",
      placeholder: "Search tasks...",
    },
    {
      columnId: "status",
      kind: "multiselect",
      placeholder: "Filter by status...",
      options: taskStatusOptions,
    },
    {
      columnId: "trade",
      kind: "multiselect",
      placeholder: "Filter by trade...",
      options: tradeOptions,
    },
    {
      // `dueDate`, not `due` — the column comes from `createPlainDateColumn`
      // keyed on the field name. The pre-manifest filter list said "due", so
      // this control matched no column and never rendered at all.
      columnId: "dueDate",
      kind: "range",
      placeholder: "Filter by due date...",
      options: dueRangeOptions,
      expand: resolveDueRange,
    },
    {
      columnId: "project",
      field: "projectId",
      kind: "idMulti",
      brand: unsafeProjectId,
      placeholder: "Filter by project...",
      optionsKey: "project",
      nullable: { field: "projectPresenceFilter", label: "project" },
    },
  ],

  product: [
    {
      columnId: "name",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by name...",
    },
    {
      columnId: "manufacturer",
      field: "manufacturerFilter",
      kind: "text",
      placeholder: "Filter by manufacturer...",
    },
    {
      columnId: "upc",
      field: "upcFilter",
      kind: "text",
      placeholder: "Filter by upc...",
    },
    {
      columnId: "category",
      field: "categoryFilter",
      kind: "multiselect",
      placeholder: "Filter by category...",
      options: productCategoryOptionsWithTheme,
      nullable: { field: "categoryPresenceFilter", label: "category" },
    },
    {
      columnId: "location",
      field: "inventoryPresenceFilter",
      kind: "presence",
      placeholder: "Filter locations...",
      options: presenceFilterOptions("inventory"),
    },
    {
      columnId: "ingredient",
      field: "ingredientPresenceFilter",
      kind: "presence",
      placeholder: "Filter ingredient...",
      options: presenceFilterOptions("ingredient"),
    },
    {
      columnId: "purchases",
      field: "purchasePresenceFilter",
      kind: "presence",
      placeholder: "Filter purchases...",
      options: presenceFilterOptions("purchases"),
    },
    {
      // "USDA key", not "USDA food" — the predicate is `fdc_id IS NOT NULL OR
      // upc IS NOT NULL`, and SQL can't know whether the usda worker actually
      // resolves a food for that key. See `usdaPresenceFilter`'s schema doc.
      columnId: "food",
      field: "usdaPresenceFilter",
      kind: "presence",
      placeholder: "Filter USDA...",
      options: presenceFilterOptions("USDA key"),
    },
    {
      columnId: "image",
      field: "imagePresenceFilter",
      kind: "presence",
      placeholder: "Filter images...",
      options: presenceFilterOptions("image"),
    },
    {
      // Bare presence, not a quality tier — and it has to stay that way. The
      // cell's tier is conversion COVERAGE: graph reachability through the unit
      // engine over stored edges PLUS USDA-derived ones (portions, servings,
      // per-nutrient calories) that live in the usda-api service, not Postgres.
      // No SQL predicate can reproduce it, so a "Complete/Good/Partial" control
      // here would return rows whose badge says something else. Presence has no
      // such conflict: "(none)" is exactly "no chips", which is always tier
      // `none`. A truthful quality filter needs a persisted coverage column.
      columnId: "unitMappingQuality",
      field: "unitMappingPresenceFilter",
      kind: "presence",
      placeholder: "Filter mappings...",
      options: presenceFilterOptions("mappings"),
    },
    {
      // Compatibility/grouping tags — the same value sits on a tool and on the
      // consumables that fit it, so this answers "what's in the 4.5in grinder
      // ecosystem". Options come from `product.tagOptions` at runtime (free
      // text, so there's no static roster). `(none)` is the untagged worklist.
      columnId: "tags",
      field: "tagFilters",
      kind: "multiselect",
      placeholder: "Filter by tag...",
      optionsKey: "tags",
      nullable: { field: "tagsPresenceFilter", label: "tags" },
    },
  ],

  recipe: [
    {
      columnId: "name",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by recipe name...",
    },
    {
      // Already array-shaped server-side (`recipe.tags && tagFilters`, a
      // Postgres array overlap — i.e. ANY/OR semantics), so this is the
      // cheapest column to give a real multi-select control to.
      columnId: "tags",
      field: "tagFilters",
      kind: "multiselect",
      placeholder: "Filter by tag...",
      optionsKey: "tags",
      nullable: { field: "tagsPresenceFilter", label: "tags" },
    },
    {
      // The Source column renders the cookbook link (RecipeSourceLink) for
      // book recipes; this scopes it to one or more cookbooks.
      columnId: "source",
      field: "cookbookId",
      kind: "idMulti",
      brand: unsafeCookbookId,
      placeholder: "Filter by cookbook...",
      optionsKey: "cookbook",
      nullable: { field: "cookbookPresenceFilter", label: "cookbook" },
    },
    {
      // "none" is the never-planned worklist. A live MealRecipe under a
      // soft-deleted Meal doesn't count.
      columnId: "meals",
      field: "mealPresenceFilter",
      kind: "presence",
      placeholder: "Filter meals...",
      options: presenceFilterOptions("meals"),
    },
    {
      columnId: "image",
      field: "imagePresenceFilter",
      kind: "presence",
      placeholder: "Filter images...",
      options: presenceFilterOptions("image"),
    },
  ],

  ingredient: [
    {
      columnId: "name",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by ingredient name...",
    },
    {
      columnId: "product",
      field: "productPresenceFilter",
      kind: "presence",
      placeholder: "Filter product...",
      options: presenceFilterOptions("product"),
    },
    {
      // "none" is the orphaned-ingredient worklist — the list already excludes
      // recipe-as-ingredient pointer rows, so a hit really is unused.
      columnId: "appearsInRecipes",
      field: "recipePresenceFilter",
      kind: "presence",
      placeholder: "Filter recipes...",
      options: presenceFilterOptions("recipes"),
    },
  ],

  inventory: [
    {
      columnId: "product",
      field: "productNameFilter",
      kind: "text",
      placeholder: "Filter by product...",
    },
    {
      columnId: "location",
      field: "locationNameFilter",
      kind: "text",
      placeholder: "Filter by location...",
    },
  ],

  location: [
    {
      columnId: "name",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by location name...",
    },
    {
      columnId: "type",
      field: "itemTypeFilter",
      kind: "multiselect",
      placeholder: "Filter by type...",
      options: locationTypeOptionsWithTheme,
    },
    {
      // Matches direct children only — this is what the Parent column
      // literally shows on each row. There's no location-side descendant walk
      // (unlike projects' `collectDescendantIds`); subtree scoping would be a
      // separate, larger change.
      columnId: "parent",
      field: "parentId",
      kind: "idMulti",
      brand: unsafeLocationId,
      placeholder: "Filter parent...",
      optionsKey: "parentLocation",
      nullable: { field: "parentPresenceFilter", label: "parent" },
    },
    {
      // "none" is the empty-shelf worklist. Counts only entries whose product
      // is live, matching what the cell renders (it drops deleted products).
      columnId: "inventoryEntries",
      field: "inventoryPresenceFilter",
      kind: "presence",
      placeholder: "Filter inventory...",
      options: presenceFilterOptions("inventory"),
    },
  ],

  image: [
    {
      columnId: "filename",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by filename...",
    },
  ],

  // Client-side tree table: this filters in the browser (`useClientEntityList`
  // runs with manualFiltering off), so the spec is presentation-only — no
  // `field` reaches a server filter object. Status/kind are deliberately NOT
  // here: the dashboard's chips (`?statuses=&kinds=`) already scope this
  // table's data server-side, and a second column-filter on the same concept
  // would silently AND with the chips instead of replacing them — see
  // `ProjectTable`'s comment in `app/projects/shared.tsx`.
  project: [
    {
      columnId: "name",
      kind: "text",
      placeholder: "Filter by project name...",
    },
  ],
};

/** The specs for an entity, or an empty list when it has no list table. */
export const getEntityFilters = (entity: Entity): readonly FilterSpec[] =>
  entityFilters[entity] ?? [];

/**
 * The `FilterConfig` for one column, straight from the manifest.
 *
 * `useStandardColumns` applies this to every column automatically. Tables that
 * bypass that hook (the embedded project-detail tables, which are raw
 * `useReactTable` over a caller-supplied array) call it explicitly through
 * their column factories, so their controls match the index pages' instead of
 * silently staying single-select.
 */
export function manifestFilterConfig(
  entity: Entity,
  columnId: string,
  runtimeOptions?: Record<string, FilterableComboboxItem[]>,
): FilterConfig | undefined {
  const spec = getEntityFilters(entity).find((s) => s.columnId === columnId);
  if (!spec) return undefined;
  // A runtime picklist (project roster, tag universe) can't be static module
  // data, so the caller injects it by key.
  const resolvedOptions = spec.optionsKey
    ? (runtimeOptions?.[spec.optionsKey] ?? [])
    : (spec.options ?? []);
  // Sentinels come first so they're reachable without scrolling a long roster.
  const options = spec.nullable
    ? [...nullableSentinelOptions(spec.nullable.label), ...resolvedOptions]
    : resolvedOptions;
  return {
    placeholder: spec.placeholder,
    filterType: filterTypeForKind(spec.kind),
    options,
  };
}

/**
 * `validateSearch` fragment for an entity's filter params.
 *
 * A route with a strict `z.object` schema strips any key it doesn't declare —
 * so without this, `useTableState` writes a filter to the URL and the router
 * removes it again before anything can read it back. Derived from the manifest
 * rather than hand-listed per route, so a new spec can't be forgotten here.
 *
 * Every value is a {@link urlStringParam}: sets are comma-joined, and the enums
 * are validated where they're consumed (`decodeFilters` →
 * `buildFiltersFromManifest` → the tRPC input schema). Routes that ALSO
 * re-declare a key by name (for `<Link search>` literal key types) must use it
 * there too — a bare `z.string()` reinstates the silently-dropped-value hole
 * that schema exists to close.
 */
export function entityFilterSearchFields(
  entity: Entity,
): Record<string, typeof urlStringParam> {
  const fields: Record<string, typeof urlStringParam> = {};
  for (const spec of getEntityFilters(entity)) {
    fields[spec.urlKey ?? spec.columnId] = urlStringParam;
  }
  return fields;
}

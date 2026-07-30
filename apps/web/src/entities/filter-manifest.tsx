import type { Entity } from "@cubby/schemas/entity";
import {
  unsafeCookbookId,
  unsafeLocationId,
  unsafeProductId,
  unsafeProjectId,
  unsafeVendorId,
} from "@cubby/schemas/identifiers";
import type { FilterConfig } from "~/app/_components/data-table/columnHelpers";
import { locationTypeOptionsWithTheme } from "~/app/_components/locations/location-icons";
import { productCategoryOptionsWithTheme } from "~/app/_components/products/product-category-icons";
import {
  costTypeOptions,
  dateRangeOptions,
  futureFilterOptions,
  resolveDateRange,
} from "~/app/expenses/expense-options";
import { tradeOptions } from "~/app/projects/trade-options";
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
  expense: [
    {
      columnId: "name",
      field: "search",
      // `?q=`, not `?name=` — an established link shape (command palette, the
      // "see all in ledger" links), kept working across the URL-sync move.
      urlKey: "q",
      kind: "text",
      placeholder: "Search expenses...",
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
      // Vendor **ids**, not the free-text name that used to sit on the row: a
      // vendor is a real entity now, reached through the charge
      // (`expense.purchaseId → Purchase.vendorId`). So this is `idMulti` on
      // `vendorId`, modelled on `project` above — the column still RENDERS the
      // name, but the roster and the filter trade in ids, which is what makes
      // "Amazon (254)" unable to drag in "Amazon Business".
      //
      // Options come from `expense.vendorOptions` at runtime (`{id, name,
      // count}`): a bounded roster, but a DB one, so it can't be static module
      // data. Each option keeps the vendor's brand mark and row count.
      //
      // The URL key stays `vendor` and now holds an id — same shape as
      // `?project=<projectId>`. A stale bookmark carrying a vendor NAME simply
      // matches nothing; there's no name→id fallback, since resolving one would
      // mean guessing at a roster the URL can't see.
      //
      // `(none)` is the where-did-this-come-from worklist: `purchase.vendorId`
      // is NOT NULL, so "no vendor" and "no charge attached" are one predicate.
      columnId: "vendor",
      field: "vendorId",
      kind: "idMulti",
      brand: unsafeVendorId,
      placeholder: "Filter by vendor...",
      optionsKey: "vendor",
      nullable: { field: "vendorPresenceFilter", label: "vendor" },
    },
    {
      // "none" is the unreconciled worklist — no order id recorded. The id lives
      // on the CHARGE now, so this covers both "a charge with no order id" and
      // "no charge at all"; both have always read as "no order id" here.
      columnId: "orderId",
      field: "orderIdPresenceFilter",
      kind: "presence",
      placeholder: "Filter by order id...",
      options: presenceFilterOptions("order id"),
    },
    {
      // URL-only, like `productId` above — seeded by the charge section's header
      // and the ledger's Order # cell, surfaced as a ScopeChip.
      // Its `columnId` can't be `orderId`: that one is the presence control,
      // and a second spec on the same id would read the same filter slot.
      //
      // No longer paired with a vendor. The order id resolves through
      // `purchaseId`, and `(vendorId, orderId)` is partial-unique on the charge,
      // so a short id like Tool Nirvana's "#11325" can't reach another
      // retailer's — the pairing existed only because the old key was two loose
      // string columns on the ledger row.
      columnId: "orderIdExact",
      urlOnly: true,
      field: "orderId",
      urlKey: "order",
      kind: "id",
      placeholder: "Filter by order id...",
    },
  ],

  // The roster of places money goes. One spec, covering all of
  // `vendorFiltersSchema` (packages/schemas/src/vendor.ts) — just `search`. The
  // rollup columns (`purchaseCount`, `spend`) are correlated subqueries the repo
  // computes for display and sorting; there is no server filter behind either,
  // so neither gets a spec.
  vendor: [
    {
      // `?q=`, like the ledger's name search and purchases' `q` — the money
      // family's search key. `field: "search"` because the server matches it as
      // a substring of the vendor NAME (`vendorFilterFields.search`).
      columnId: "name",
      field: "search",
      urlKey: "q",
      kind: "text",
      placeholder: "Search vendors...",
    },
  ],

  // One row per vendor charge. Five specs, covering `purchaseFiltersSchema`
  // (packages/schemas/src/purchase.ts) apart from its exact `orderId` match —
  // nothing deep-links a charge by order id (a charge has its own detail route),
  // so there's no `orderIdExact`-style URL-only scope here the way expense has.
  purchase: [
    {
      // `?q=`, the money family's search key — and it hangs on `charge`, not
      // `orderId`. `charge` IS purchase's name column (`standardColumns` is
      // `[]`, so there's no hook-prepended `name`): a bespoke accessor over
      // `purchaseLabel`, which is why it's absent from `purchaseSortableFields`
      // and stays unsortable. Server-side the term is a substring match on the
      // ORDER ID; the `orderId` column's own control is the presence worklist
      // below, and two specs can't share a `columnId` — they'd read the same
      // filter slot.
      columnId: "charge",
      field: "search",
      urlKey: "q",
      kind: "text",
      placeholder: "Search order id...",
    },
    {
      // Id-based, like the ledger's vendor filter: the column RENDERS
      // `vendorName`, but the roster and the filter trade in ids.
      //
      // No `nullable` sentinels — `Purchase.vendorId` is NOT NULL, so there is
      // no "(none)" cohort to offer. (Expense's vendor filter does have them,
      // because there "no vendor" means "no charge attached".)
      //
      // `optionsKey: "vendor"` names the same key as expense's spec but is fed a
      // DIFFERENT roster: this page injects `vendor.options` (charge counts),
      // the ledger injects `expense.vendorOptions` (ledger-row counts). Rosters
      // stay page-fed per `filterOptions`; they must not be collapsed into one
      // shared options hook.
      columnId: "vendor",
      field: "vendorId",
      kind: "idMulti",
      brand: unsafeVendorId,
      placeholder: "Filter by vendor...",
      optionsKey: "vendor",
    },
    {
      // "(none)" is the reconciliation worklist: the ~40% of charges the vendor
      // never issued an order id for.
      columnId: "orderId",
      field: "orderIdPresenceFilter",
      kind: "presence",
      placeholder: "Filter by order id...",
      options: presenceFilterOptions("order id"),
    },
    {
      // Same presets and expander as the ledger's date filter — one `?date=30d`
      // means the same window on both money tables.
      columnId: "date",
      kind: "range",
      placeholder: "Filter by date...",
      options: dateRangeOptions,
      expand: resolveDateRange,
    },
    {
      // "(none)" is the charges with no paperwork total recorded yet — the ones
      // `ReconciliationBadge` has nothing to reconcile against.
      columnId: "statedTotal",
      field: "statedTotalPresenceFilter",
      kind: "presence",
      placeholder: "Filter by stated total...",
      options: presenceFilterOptions("stated total"),
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
      columnId: "expenses",
      field: "expensePresenceFilter",
      kind: "presence",
      placeholder: "Filter expenses...",
      options: presenceFilterOptions("expenses"),
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

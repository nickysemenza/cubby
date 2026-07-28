import type { Entity } from "@cubby/schemas/entity";
import { unsafeProductId, unsafeProjectId } from "@cubby/schemas/identifiers";
import { z } from "zod";
import type { FilterConfig } from "~/app/_components/data-table/columnHelpers";
import { locationTypeOptionsWithTheme } from "~/app/_components/locations/location-icons";
import { productCategoryOptionsWithTheme } from "~/app/_components/products/product-category-icons";
import {
  PROJECT_STATUS_OPTIONS,
  projectKindOptions,
} from "~/app/projects/project-options";
import { tradeOptions } from "~/app/projects/trade-options";
import {
  costTypeOptions,
  dateRangeOptions,
  futureFilterOptions,
  productLinkedOptions,
  resolveDateRange,
} from "~/app/purchases/purchase-options";
import {
  dueRangeOptions,
  resolveDueRange,
  taskStatusOptions,
} from "~/app/tasks/task-options";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import {
  type FilterKind,
  type FilterSpecCore,
  isMultiFilterKind,
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
 * `tradeOptions` / `PROJECT_STATUS_OPTIONS` live in leaf modules rather than
 * in `app/projects/shared.tsx`.
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
  /**
   * Append a `(count)` of matching rows to each option. Only meaningful on
   * tables that load their full dataset client-side — TanStack's faceting
   * sees the current page only, so it's misleading on server-paginated ones.
   */
  facetCount?: boolean;
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
      columnId: "project",
      field: "projectId",
      kind: "idMulti",
      brand: unsafeProjectId,
      placeholder: "Filter by project...",
      optionsKey: "project",
    },
    {
      // No column renders this — it's seeded from the URL only (a deep link
      // from a product's detail page). Declared so the builder still maps it.
      columnId: "productId",
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
      options: productLinkedOptions,
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
      columnId: "parent",
      field: "parentPresenceFilter",
      kind: "presence",
      placeholder: "Filter parent...",
      options: presenceFilterOptions("parent"),
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

  // Client-side tree table: these filter in the browser (`useClientEntityList`
  // runs with manualFiltering off), so the specs are presentation-only — no
  // `field` reaches a server filter object. Status/kind scoping for the
  // dashboard as a whole lives in its chips, not here.
  project: [
    {
      columnId: "name",
      kind: "text",
      placeholder: "Filter by project name...",
    },
    {
      columnId: "status",
      kind: "multiselect",
      placeholder: "Filter by status...",
      options: PROJECT_STATUS_OPTIONS,
    },
    {
      columnId: "kind",
      kind: "multiselect",
      placeholder: "Filter by kind...",
      options: projectKindOptions,
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
  return {
    placeholder: spec.placeholder,
    filterType: filterTypeForKind(spec.kind),
    // A runtime picklist (project roster, tag universe) can't be static module
    // data, so the caller injects it by key.
    options: spec.optionsKey
      ? (runtimeOptions?.[spec.optionsKey] ?? [])
      : spec.options,
    facetCount: spec.facetCount,
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
 * Values stay `z.string()`: sets are comma-joined, and the enums are validated
 * where they're consumed (`decodeFilters` → `buildFiltersFromManifest` → the
 * tRPC input schema). `.catch(undefined)` keeps a malformed value from
 * throwing the whole route.
 */
export function entityFilterSearchFields(
  entity: Entity,
): Record<string, z.ZodType<string | undefined>> {
  const fields: Record<string, z.ZodType<string | undefined>> = {};
  for (const spec of getEntityFilters(entity)) {
    fields[spec.urlKey ?? spec.columnId] = z
      .string()
      .optional()
      .catch(undefined);
  }
  return fields;
}

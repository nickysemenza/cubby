import { searchableEntitySchema, type SearchHit } from "@cubby/schemas/search";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { entityDetailFor } from "~/entities/entity-detail.functions";
import { getEntityFilters } from "~/entities/filter-manifest";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { search } from "~/lib/search.functions";

import type { ComboboxItem } from "./combobox-types";

/**
 * Filter values supplied by a manifest reference's dependent-field scope.
 * `null` means the scope is declared but not ready yet; callers must not
 * widen that request into an unscoped candidate list.
 */
export type EntitySearchScope = Readonly<
  Record<string, string | readonly string[]>
>;

export const pagination = {
  pageIndex: 0,
  pageSize: 20,
};

/** The entities `WithEntitySearch` drives end-to-end (list + typed + exact-code + optional create). */
export type PickerSearchEntity =
  | "ingredient"
  | "ledgerParty"
  | "location"
  | "product"
  | "recipe"
  | "project"
  | "task"
  | "planting"
  | "vendor";

/**
 * Row source for the blank- or typed-query branch. Hook-shaped (its own
 * `useQuery` runs unconditionally every render) so per-entity variants can be
 * selected by plain object lookup — `config.useListSource(...)` — without ever
 * putting a hook call inside a branch.
 */
type EntitySearchRowSource<TRow> = (
  searchQuery: string,
  enabled: boolean,
  scope?: EntitySearchScope | null,
) => { data: TRow[] | undefined; isLoading: boolean };

export interface UseEntitySearchConfig<TId extends string, TRow, TDetail> {
  /**
   * Detail-shaped placeholder id queried (disabled) while no exact code is
   * typed — keeps the exact-lookup `useQuery` call unconditional.
   */
  detailPlaceholder: string;
  /**
   * false collapses the blank/typed split into a single always-live source
   * (product: one `product.search` call for every query, typed or not).
   */
  splitBlankTyped: boolean;
  /** False for list-backed entities that are intentionally absent from global search. */
  supportsGlobalSearch?: boolean;
  /** Hook-shaped row source for the blank-query (or, when `splitBlankTyped`
   * is false, every) branch. */
  useListSource: EntitySearchRowSource<TRow>;
  /** Maps a list/search row into a picker item. */
  build: (row: TRow) => ComboboxItem<TId>;
  /** Maps an exact-code detail read into a picker item (may differ in shape
   * from `build`'s list rows — location's ancestor chain, for instance). */
  buildDetail: (row: TDetail) => ComboboxItem<TId>;
  /** Maps a global-search hit into a picker item for the typed-query branch
   * (vendor's name-keyed picker overrides the id onto the hit's title). */
  buildSearchHit: (hit: SearchHit) => ComboboxItem<TId>;
  /**
   * Hook-shaped: resolves the value handed to the picker as `onCreateNew`.
   * Receives the raw dialog-opening function; returns `undefined` for
   * entities with no create-from-picker affordance.
   */
  useOnCreateNew: (
    openDialog: (name: string) => Promise<ComboboxItem<TId>>,
  ) => ((name: string) => Promise<ComboboxItem<TId>>) | undefined;
  /**
   * "dialog"/"upcAware" render `EntitySearchCreateDialog` (the generic
   * `EntityEditDialog` capture request, or `ProductCreateDialog` for
   * product) on create; "none" leaves creation entirely to `useOnCreateNew`
   * (vendor mints its own row on save, with no dialog in the picker at all).
   */
  createNew: "dialog" | "upcAware" | "none";
  /** Required when `createNew` isn't "none": parses the dialog's raw save
   * result into the shape `buildDetail` expects. */
  parseCreatedResult?: CreatedResultParser<TDetail>;
}

/** A boundary parser for a create dialog's raw save result. */
export type CreatedResultParser<TDetail> = (
  result: unknown,
) => TDetail | undefined;

/**
 * Defer an entity-list options query until the picker is first opened (or the
 * user starts typing). Returns an `enabled` flag for the query plus the
 * `onOpenChange` handler to hand back through the render prop. Once activated it
 * stays on, so closing/reopening keeps the cached options.
 */
export function useDeferredSearch(searchQuery: string) {
  const [activated, setActivated] = useState(false);
  const onOpenChange = useCallback((open: boolean) => {
    if (open) setActivated(true);
  }, []);
  return {
    enabled: activated || searchQuery.length > 0,
    onOpenChange,
  };
}

/**
 * Custom hook for basic entity search (no dialog).
 * Use this for simple search-only scenarios or when creating entities without a dialog.
 */
export function useEntitySearch() {
  const [searchQuery, setSearchQuery] = useState("");

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  return {
    searchQuery,
    onSearchChange,
  };
}

/**
 * Custom hook for entity search with dialog-based creation.
 * Extracts common state management for search hooks that need:
 * - Search query state
 * - Dialog open/close state
 * - Promise-based dialog resolution for combobox integration
 *
 * Generic over the branded entity id so created items keep their branding
 * end-to-end (picker → onSave).
 */
function useEntitySearchWithDialog<TId extends string = string>() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const pendingPromiseRef = useRef<{
    resolve: (item: ComboboxItem<TId>) => void;
    reject: (error: Error) => void;
  } | null>(null);

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const openDialog = useCallback((name: string): Promise<ComboboxItem<TId>> => {
    setPendingName(name);
    setIsDialogOpen(true);
    return new Promise<ComboboxItem<TId>>((resolve, reject) => {
      pendingPromiseRef.current = { resolve, reject };
    });
  }, []);

  const closeDialog = useCallback(() => {
    setIsDialogOpen(false);
    pendingPromiseRef.current?.reject(new Error("Entity creation cancelled"));
    pendingPromiseRef.current = null;
  }, []);

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) setIsDialogOpen(true);
      else closeDialog();
    },
    [closeDialog],
  );

  const resolveWithEntity = useCallback((item: ComboboxItem<TId>) => {
    setIsDialogOpen(false);
    if (pendingPromiseRef.current) {
      pendingPromiseRef.current.resolve(item);
      pendingPromiseRef.current = null;
    }
  }, []);

  return {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen: handleDialogOpenChange,
    pendingName,
    openDialog,
    closeDialog,
    resolveWithEntity,
  };
}

/**
 * Fallback only: the manifest-declared `name` column normally carries the
 * blank-query filter field itself (`nameFilter` for product/recipe/ingredient/
 * location, `search` for project/task). Used only if an entity's filter
 * descriptors have no `name` column — not expected to trigger for any current
 * `PickerSearchEntity`.
 */
const FALLBACK_BLANK_FILTER_KEY = {
  ingredient: "nameFilter",
  ledgerParty: "nameFilter",
  location: "nameFilter",
  product: "nameFilter",
  recipe: "nameFilter",
  project: "search",
  task: "search",
  planting: "searchQuery",
} satisfies Record<Exclude<PickerSearchEntity, "vendor">, string>;

/** Resolves the filter field a blank-query list request should key on. */
export function resolveBlankFilterKey(
  entity: Exclude<PickerSearchEntity, "vendor">,
): string {
  const nameFilter = getEntityFilters(entity).find(
    (spec) => spec.columnId === "name",
  );
  return nameFilter?.field ?? FALLBACK_BLANK_FILTER_KEY[entity];
}

const resolveSearchPath = (
  searchQuery: string,
  entity: PickerSearchEntity,
  config: Pick<
    UseEntitySearchConfig<string, unknown, unknown>,
    "splitBlankTyped" | "supportsGlobalSearch"
  >,
  scope?: EntitySearchScope | null,
) => {
  const parsedCode = parseShortcode(searchQuery);
  const exactCode = parsedCode?.type === entity ? parsedCode.shortcode : null;
  const searchingByCode = Boolean(parsedCode);
  const useBlankPath =
    scope !== undefined ||
    config.supportsGlobalSearch === false ||
    !config.splitBlankTyped ||
    searchQuery.trim() === "";
  const globalSearchEntity =
    config.supportsGlobalSearch === false
      ? "product"
      : searchableEntitySchema.parse(entity);
  return {
    exactCode,
    searchingByCode,
    useBlankPath,
    globalSearchEntity,
  };
};

/**
 * Renumbers each grouped item's `presentation.group.order` to its group's
 * first-appearance index in `items` — every builder that stamps a group
 * (e.g. `buildLocationComboboxItem`) has no visibility into its siblings, so
 * it can only ever assign one constant. The blank-query roster is typically
 * sorted by the row's OWN name, not clustered by root, so without this a
 * root's rows interleave with other roots' and the group header (rendered
 * on every `group.id` transition, `EntityPicker`) would repeat. Leaves
 * ungrouped items untouched and preserves each group's internal order.
 */
export function stabilizeGroupOrder<TId extends string>(
  items: readonly ComboboxItem<TId>[],
): ComboboxItem<TId>[] {
  const orderByGroupId = new Map<string, number>();
  return items.map((item) => {
    const group = item.presentation?.group;
    if (!group) return item;
    let order = orderByGroupId.get(group.id);
    if (order === undefined) {
      order = orderByGroupId.size;
      orderByGroupId.set(group.id, order);
    }
    return order === group.order
      ? item
      : {
          ...item,
          presentation: { ...item.presentation, group: { ...group, order } },
        };
  });
}

const buildSearchItems = <
  E extends PickerSearchEntity,
  TId extends string,
  TRow,
  TDetail,
>(
  searchingByCode: boolean,
  scopeReady: boolean,
  exactItem: EntityDetailByEntity[E] | null | undefined,
  useBlankPath: boolean,
  rows: readonly TRow[] | undefined,
  searchHits: readonly SearchHit[] | undefined,
  config: UseEntitySearchConfig<TId, TRow, TDetail>,
): ComboboxItem<TId>[] => {
  if (searchingByCode) {
    if (!scopeReady || !exactItem) return [];
    // SAFETY: the detail query and config are selected by the same entity key;
    // TDetail is the smaller picker-facing structural shape that config needs.
    return [config.buildDetail(exactItem as TDetail)];
  }
  if (useBlankPath) return stabilizeGroupOrder((rows ?? []).map(config.build));
  return (searchHits ?? []).map(config.buildSearchHit);
};

const searchLoading = (
  exactCode: string | null,
  useBlankPath: boolean,
  states: { exact: boolean; rows: boolean; search: boolean },
): boolean => {
  if (exactCode) return states.exact;
  return useBlankPath ? states.rows : states.search;
};

/**
 * Shared orchestration behind every entity combobox: search-query + optional
 * dialog state, the exact-shortcode detail lookup, and the blank/typed row
 * queries — resolved via `config`'s hook-shaped `useListSource`/
 * `useOnCreateNew` so a single object-property call site stays unconditional
 * regardless of which entity is active (see each field's doc for why).
 */
export function useEntitySearchRows<
  E extends PickerSearchEntity,
  TId extends string,
  TRow,
  TDetail,
>(
  entity: E,
  config: UseEntitySearchConfig<TId, TRow, TDetail>,
  scope?: EntitySearchScope | null,
) {
  const {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    resolveWithEntity,
  } = useEntitySearchWithDialog<TId>();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  // `undefined` means this picker has no dependent scope. `null` means it
  // does, but one of its source fields is currently empty. Treating the latter
  // as disabled is important: a missing location/date must never turn a
  // contextual planting picker into an all-plantings query.
  const scopeReady = scope !== null;

  const { exactCode, searchingByCode, useBlankPath, globalSearchEntity } =
    resolveSearchPath(searchQuery, entity, config, scope);

  const { data: rows, isLoading: isRowsLoading } = config.useListSource(
    searchQuery,
    enabled && scopeReady && !searchingByCode && useBlankPath,
    scope,
  );
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...search.find.queryOptions({
      query: searchQuery || entity,
      entityTypes: [globalSearchEntity],
      limit: 20,
    }),
    enabled:
      enabled &&
      scopeReady &&
      !searchingByCode &&
      config.splitBlankTyped &&
      !useBlankPath,
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailFor(entity).queryOptions(
      exactCode ?? config.detailPlaceholder,
      { enabled: exactCode != null && scopeReady },
    ),
  );

  const onCreateNew = config.useOnCreateNew(openDialog);

  const items = buildSearchItems(
    searchingByCode,
    scopeReady,
    exactItem,
    useBlankPath,
    rows,
    searchHits,
    config,
  );
  const isLoading = searchLoading(exactCode, useBlankPath, {
    exact: isExactLoading,
    rows: isRowsLoading,
    search: isSearchLoading,
  });

  return {
    items,
    isLoading,
    onSearchChange,
    onOpenChange,
    onCreateNew,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    resolveWithEntity,
  };
}

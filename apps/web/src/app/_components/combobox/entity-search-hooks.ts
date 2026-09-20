import { searchableEntitySchema, type SearchHit } from "@cubby/schemas/search";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { entityDetailFor } from "~/entities/entity-detail.functions";
import { getEntityFilters } from "~/entities/filter-manifest";
import { search } from "~/lib/search.functions";

import type { ComboboxItem } from "./combobox-types";

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
>(entity: E, config: UseEntitySearchConfig<TId, TRow, TDetail>) {
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

  const parsedCode = parseShortcode(searchQuery);
  const exactCode = parsedCode?.type === entity ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;
  const hasTypedText = searchQuery.trim() !== "";
  const useBlankPath =
    config.supportsGlobalSearch === false ||
    !config.splitBlankTyped ||
    !hasTypedText;
  const globalSearchEntity =
    config.supportsGlobalSearch === false
      ? "product"
      : searchableEntitySchema.parse(entity);

  const { data: rows, isLoading: isRowsLoading } = config.useListSource(
    searchQuery,
    enabled && !searchingByCode && useBlankPath,
  );
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...search.find.queryOptions({
      query: searchQuery || entity,
      entityTypes: [globalSearchEntity],
      limit: 20,
    }),
    enabled:
      enabled && !searchingByCode && config.splitBlankTyped && !useBlankPath,
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailFor(entity).queryOptions(
      exactCode ?? config.detailPlaceholder,
      { enabled: exactCode != null },
    ),
  );

  const onCreateNew = config.useOnCreateNew(openDialog);

  const items: ComboboxItem<TId>[] = searchingByCode
    ? exactItem
      ? // SAFETY: `entityDetailFor(entity).queryOptions` is keyed by the same
        // `entity` this `config` was built for, so its result already matches
        // `TDetail` — TS can't thread that through the generic `E`/`TDetail`
        // pair on its own.
        [config.buildDetail(exactItem as TDetail)]
      : []
    : useBlankPath
      ? (rows ?? []).map(config.build)
      : (searchHits ?? []).map((hit) => config.buildSearchHit(hit));

  const isLoading = exactCode
    ? isExactLoading
    : useBlankPath
      ? isRowsLoading
      : isSearchLoading;

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

import type { SortParams } from "@cubby/schemas/pagination";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  type ColumnFilter,
  ColumnFiltersState,
  functionalUpdate,
  PaginationState,
  SortingState,
} from "@tanstack/react-table";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { z } from "zod";

import {
  compileFilterCodec,
  type FilterCodec,
  type FilterSpecCore,
  type FilterValue,
  paramToSort,
  sortToParam,
} from "~/entities/filters";

import {
  buildSortParams,
  buildSortsParams,
  defaultPagination,
  defaultSortState,
} from "./tableUtils";

interface TableStateOptions {
  initialSort?: string;
  initialSortDesc?: boolean;
  initialFilter?: ColumnFiltersState;
  initialPagination?: PaginationState;
  filterSpecs?: readonly FilterSpecCore[];
  /** Generated workbench search metadata, kept separate from field filters. */
  primarySearch?: { key: string } | null;
  /**
   * Mirror sort + pagination to the URL search params (bookmarkable / shareable
   * / survives reload). The live URL is authoritative after mount; guarded
   * write-through keeps local interactions and browser navigation from
   * fighting. Enable on exactly one tableState per page (the active data hook)
   * — see useEntityList.
   */
  urlSync?: boolean;
  /**
   * Read sort, filters, and pagination from the current URL. Defaults to true
   * so standalone/read-only table state keeps honoring shared links even when
   * it is not the URL writer. Set false for a table embedded beside the page's
   * owning table; otherwise foreign params such as a Project `sort=startDate`
   * can become invalid Task/Expense query input. `urlSync` always implies URL
   * reads, regardless of this value.
   */
  readUrlState?: boolean;
  syncPaginationToUrl?: boolean;
}

const NO_SPECS: readonly FilterSpecCore[] = [];
// Route validators intentionally retain optional keys with `undefined` values.
// They are valid router state even though JSON serialization later omits them.
const routerSearchSchema = z.record(z.string(), z.json().optional());
type RouterSearchState = z.output<typeof routerSearchSchema>;
const NO_URL_STATE: RouterSearchState = {};
const NO_INITIAL_FILTER: ColumnFiltersState = [];
const filterValueSchema = z.union([z.string(), z.array(z.string())]).optional();

function parseFilterValue(value: ColumnFilter["value"]): FilterValue {
  const parsed = filterValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const SORT_KEY = "sort";
const PAGE_KEY = "page";
const SIZE_KEY = "pageSize";

function serializeUrlState(
  sorting: SortingState,
  columnFilters: ColumnFiltersState,
  pagination: PaginationState,
  codec: FilterCodec,
  initialSort: string,
  initialSortDesc: boolean,
  syncPaginationToUrl: boolean,
): string {
  const sort = sortToParam(sorting);
  return JSON.stringify({
    ...codec.encode((columnId) =>
      parseFilterValue(
        columnFilters.find((filter) => filter.id === columnId)?.value,
      ),
    ),
    // The default sort stays implicit in the URL - only a departure from it is
    // written, so a freshly opened list keeps a clean query string.
    [SORT_KEY]:
      sort === `${initialSortDesc ? "-" : ""}${initialSort}` ? undefined : sort,
    [PAGE_KEY]:
      syncPaginationToUrl && pagination.pageIndex > 0
        ? pagination.pageIndex + 1
        : undefined,
    [SIZE_KEY]:
      syncPaginationToUrl && pagination.pageSize !== defaultPagination.pageSize
        ? pagination.pageSize
        : undefined,
  });
}

export interface TableStateReturn {
  sorting: SortingState;
  setSorting: (
    value: SortingState | ((old: SortingState) => SortingState),
  ) => void;
  columnFilters: ColumnFiltersState;
  /**
   * `columnFilters` plus the URL-only scopes (see `urlOnly` in
   * `entities/filters`). This — not `columnFilters` — is what the server
   * filters are built from; the two are the same array when the entity
   * declares no URL-only spec.
   */
  allFilters: ColumnFiltersState;
  setColumnFilters: (
    value:
      | ColumnFiltersState
      | ((old: ColumnFiltersState) => ColumnFiltersState),
  ) => void;
  pagination: PaginationState;
  setPagination: (
    value: PaginationState | ((old: PaginationState) => PaginationState),
  ) => void;
  getColumnFilter: (columnId: string) => string | undefined;
  getColumnFilterValues: (columnId: string) => string[] | undefined;
  getSortParams: () => SortParams;
  getSorts: () => SortParams[];
  /** A URL sort is a user choice; the opening sort is not. */
  hasExplicitSort: boolean;
  /** Broad entity search is active; ordinary list filters do not set this. */
  hasPrimarySearch: boolean;
}

export function useTableState(
  options: TableStateOptions = {},
): TableStateReturn {
  const {
    initialSort = "createdAt",
    initialSortDesc = true,
    initialFilter = NO_INITIAL_FILTER,
    initialPagination = defaultPagination,
    filterSpecs = NO_SPECS,
    primarySearch = null,
    urlSync = false,
    readUrlState = true,
    syncPaginationToUrl = true,
  } = options;

  const [, startTransition] = useTransition();

  // A URL-only spec has no column to hold its value, so it's excluded from
  // every columnFilters-shaped path below (seed, encode, managed URL keys) —
  // the page that deep-links it owns that param and clears it by navigating.
  // The codec compiles that split, the keys each side owns, and the
  // encode/decode over them from one walk, so this hook never re-derives a
  // URL key on its own.
  const codec = useMemo(
    () =>
      compileFilterCodec(
        primarySearch
          ? [
              {
                columnId: primarySearch.key,
                field: primarySearch.key,
                kind: "text" as const,
              },
              ...filterSpecs,
            ]
          : filterSpecs,
      ),
    [filterSpecs, primarySearch],
  );
  const { urlOnlyKeys } = codec;

  const search = routerSearchSchema.parse(useSearch({ strict: false }));
  const navigate = useNavigate();
  const urlStateSource = urlSync || readUrlState ? search : NO_URL_STATE;
  const hasExplicitSort = paramToSort(urlStateSource[SORT_KEY]) !== undefined;

  // Lazy initializers read the URL once (first render, incl. SSR) so a shared /
  // reloaded link restores sort + page before first paint. Reading defaults on
  // even without write-through because the active mobile hook can flip after
  // hydration (useIsMobile is false at SSR); embedded peer tables explicitly
  // opt out so they cannot consume the page owner's params.
  const [sorting, setSortingRaw] = useState<SortingState>(() => {
    const fromUrl = paramToSort(urlStateSource[SORT_KEY]);
    return fromUrl ?? defaultSortState(initialSort, initialSortDesc);
  });
  // Lazy initializer: URL filters win over the caller's seed, so a shared link
  // restores the same rows before first paint.
  const [columnFilters, setColumnFiltersRaw] = useState<ColumnFiltersState>(
    () => {
      const fromUrl = codec.decodeColumns(urlStateSource);
      return fromUrl.length ? fromUrl : initialFilter;
    },
  );
  const hasPrimarySearch = columnFilters.some(
    (filter) => filter.id === primarySearch?.key && Boolean(filter.value),
  );
  // URL-only scopes are read from the LIVE url rather than seeded into state:
  // the only way to change one is to navigate (the ScopeChip's clear), and the
  // list query has to follow that.
  //
  // Keyed on the scope VALUES, never on `search` itself: the router hands back
  // a fresh `search` object on every navigation — including this hook's own
  // write-through, which fires on any sort/page/filter change — and depending
  // on that reference would churn `allFilters`, this hook's returned object,
  // and every memo downstream of it (`useEntityList`'s `currentFilters`,
  // `usePaginatedTableCore`'s `filters`). Same reason `projects-dashboard`
  // keys its filters memo off joined primitives.
  const urlOnlyKey = JSON.stringify(
    urlOnlyKeys.map((key) => urlStateSource[key] ?? null),
  );
  const urlOnlyFilters = useMemo(
    () => codec.decodeUrlOnly(urlStateSource),
    // oxlint-disable-next-line react/exhaustive-deps -- keyed on the serialized values above, not `search`'s reference, on purpose
    [codec, urlOnlyKey],
  );
  const allFilters = useMemo(
    () =>
      urlOnlyFilters.length
        ? [...columnFilters, ...urlOnlyFilters]
        : columnFilters,
    [columnFilters, urlOnlyFilters],
  );
  const [pagination, setPaginationRaw] = useState<PaginationState>(() => {
    const page = syncPaginationToUrl
      ? Number(urlStateSource[PAGE_KEY])
      : Number.NaN;
    const size = syncPaginationToUrl
      ? Number(urlStateSource[SIZE_KEY])
      : Number.NaN;
    return {
      pageIndex:
        Number.isFinite(page) && page > 0
          ? page - 1
          : initialPagination.pageIndex,
      pageSize:
        Number.isFinite(size) && size > 0 ? size : initialPagination.pageSize,
    };
  });

  // Every key this hook owns. URL-only keys are deliberately absent: no
  // column state can produce them, so this table must never delete them.
  const managedKeys = useMemo(
    () => [...codec.columnKeys, SORT_KEY, PAGE_KEY, SIZE_KEY],
    [codec],
  );
  const managedSearchKey = JSON.stringify(
    managedKeys.map((key) => urlStateSource[key] ?? null),
  );

  // Interpret live managed params exactly as the lazy initializers do. This
  // gives Back/Forward and same-route links a canonical comparison target,
  // while absent/invalid values continue to fall back to the caller defaults.
  const urlState = useMemo(() => {
    const urlFilters = codec.decodeColumns(urlStateSource);
    const page = syncPaginationToUrl
      ? Number(urlStateSource[PAGE_KEY])
      : Number.NaN;
    const size = syncPaginationToUrl
      ? Number(urlStateSource[SIZE_KEY])
      : Number.NaN;
    return {
      sorting:
        paramToSort(urlStateSource[SORT_KEY]) ??
        defaultSortState(initialSort, initialSortDesc),
      columnFilters: urlFilters.length ? urlFilters : initialFilter,
      pagination: {
        pageIndex:
          Number.isFinite(page) && page > 0
            ? page - 1
            : initialPagination.pageIndex,
        pageSize:
          Number.isFinite(size) && size > 0 ? size : initialPagination.pageSize,
      },
    };
    // oxlint-disable-next-line react/exhaustive-deps -- keyed on managed values above, not the router's fresh search-object reference
  }, [
    managedSearchKey,
    codec,
    initialSort,
    initialSortDesc,
    initialFilter,
    initialPagination,
    syncPaginationToUrl,
  ]);

  const serializedUrlState = useMemo(
    () =>
      serializeUrlState(
        sorting,
        columnFilters,
        pagination,
        codec,
        initialSort,
        initialSortDesc,
        syncPaginationToUrl,
      ),
    [
      sorting,
      columnFilters,
      pagination,
      codec,
      initialSort,
      initialSortDesc,
      syncPaginationToUrl,
    ],
  );
  const serializedSearchState = useMemo(
    () =>
      serializeUrlState(
        urlState.sorting,
        urlState.columnFilters,
        urlState.pagination,
        codec,
        initialSort,
        initialSortDesc,
        syncPaginationToUrl,
      ),
    [urlState, codec, initialSort, initialSortDesc, syncPaginationToUrl],
  );
  // Unlike `serializedSearchState`, retain explicit default and disabled-page
  // params so write-through can clean up keys this table owns.
  const serializedRawSearchState = JSON.stringify(
    Object.fromEntries(
      managedKeys
        .map((key) => [key, urlStateSource[key]])
        .filter(([, value]) => value !== undefined),
    ),
  );

  // `true` means a controlled setter has changed state but the write effect
  // has not issued navigation yet. A string is the expected URL acknowledgement.
  const pendingLocalWrite = useRef<true | string | null>(null);
  // External navigation updates three independent state atoms. Keep its
  // target until the following render has all three values, rather than
  // clearing a one-commit boolean before those updates take effect.
  const applyingExternalState = useRef<string | null>(null);
  // The managed URL params as of the last time the reconcile effect ran. An
  // external navigation is BY DEFINITION a change to these, so a run where
  // they're unchanged is just a re-render and must not reinterpret the URL.
  // Seeded with the mount value, which also covers the first run (the lazy
  // initializers already read that URL).
  const lastObservedSearch = useRef(serializedRawSearchState);

  const setSorting = useCallback(
    (value: SortingState | ((old: SortingState) => SortingState)) =>
      startTransition(() => {
        setSortingRaw((old) => {
          const next = functionalUpdate(value, old);
          if (JSON.stringify(next) !== JSON.stringify(old)) {
            pendingLocalWrite.current = true;
          }
          return next;
        });
      }),
    [],
  );
  // Mirrors columnFilters into a ref so setColumnFilters (memoized with `[]`
  // deps — see the "CRITICAL" callbacks below) can read the pre-update value
  // without going stale. Plain assignment during render, not an effect: it
  // only needs to be fresh by the time a callback fires, never drives
  // rendering itself.
  const columnFiltersRef = useRef(columnFilters);
  columnFiltersRef.current = columnFilters;

  const setColumnFilters = useCallback(
    (
      value:
        | ColumnFiltersState
        | ((old: ColumnFiltersState) => ColumnFiltersState),
    ) =>
      startTransition(() => {
        const old = columnFiltersRef.current;
        const next = functionalUpdate(value, old);
        setColumnFiltersRaw(next);
        // Reset to page 1 whenever the filters actually change. These tables
        // run manualPagination:true (see useTableConfig's default, ~L112),
        // which makes TanStack's autoResetPageIndex — it falls back to
        // `!manualPagination` — inert here; nothing else in the app resets
        // the page on a filter change (`setPageIndex` is otherwise only
        // called by data-table-pagination.tsx's first/last buttons). Left
        // alone, filtering from page 3 strands the user on page 3 of a
        // smaller (often empty) result set, with a stale `?page=3` in the
        // URL. useTableConfig wires `onColumnFiltersChange: setColumnFilters`,
        // so this setter is the single funnel for every filter change across
        // all tables (header controls, the mobile filter sheet, chip clears,
        // Reset, and a saved-view apply) — fixing it here covers all of them.
        // Guarded on an actual change so re-applying the same filters (e.g. a
        // saved view matching the current state) doesn't knock the user off
        // their page.
        if (JSON.stringify(next) !== JSON.stringify(old)) {
          pendingLocalWrite.current = true;
          setPaginationRaw((p) =>
            p.pageIndex === 0 ? p : { ...p, pageIndex: 0 },
          );
        }
      }),
    [],
  );
  const setPagination = useCallback(
    (value: PaginationState | ((old: PaginationState) => PaginationState)) =>
      startTransition(() => {
        setPaginationRaw((old) => {
          const next = functionalUpdate(value, old);
          if (JSON.stringify(next) !== JSON.stringify(old)) {
            pendingLocalWrite.current = true;
          }
          return next;
        });
      }),
    [],
  );

  const getColumnFilter = useCallback(
    (columnId: string): string | undefined => {
      const value = parseFilterValue(
        columnFilters.find((filter) => filter.id === columnId)?.value,
      );
      // A multiselect column holds `string[]`. Returning it typed as `string`
      // would send an array to a scalar zod field and blow up at the transport
      // boundary at runtime instead of here — fail loudly at the call site
      // that forgot to switch to getColumnFilterValues.
      if (Array.isArray(value)) {
        throw new Error(
          `Column "${columnId}" holds a multi-value filter; use getColumnFilterValues.`,
        );
      }
      return value;
    },
    [columnFilters],
  );

  const getColumnFilterValues = useCallback(
    (columnId: string): string[] | undefined => {
      const value = parseFilterValue(
        columnFilters.find((filter) => filter.id === columnId)?.value,
      );
      if (Array.isArray(value)) return value.length ? value : undefined;
      return value ? [value] : undefined;
    },
    [columnFilters],
  );

  const getSortParams = useCallback(() => {
    return buildSortParams(sorting, initialSort);
  }, [sorting, initialSort]);

  const getSorts = useCallback(() => {
    return buildSortsParams(sorting, initialSort, initialSortDesc);
  }, [sorting, initialSort, initialSortDesc]);

  // Live URL state is authoritative after mount, but only ON AN ACTUAL URL
  // CHANGE — the mount value is the lazy initializers' own, and a run with no
  // change is a re-render, not navigation. Of the real changes, an
  // unacknowledged local write is allowed to finish, while a different URL is
  // browser navigation and replaces all managed state atomically without the
  // filter/page-reset side effect meant for interactive edits.
  useEffect(() => {
    if (!urlSync) return;
    // Nothing in the URL moved, so there is nothing to reconcile — this run is
    // a re-render (a refetch, a parent state change, a churned dependency).
    // Without this guard, any render landing in the window between the write
    // effect issuing `navigate` and the router publishing the new search would
    // compare fresh local state against the STALE url below, read it as
    // external navigation, and overwrite the state the user just set — the
    // filters flashing into the URL and reverting on a saved-view apply.
    if (lastObservedSearch.current === serializedRawSearchState) return;
    lastObservedSearch.current = serializedRawSearchState;

    if (pendingLocalWrite.current === serializedRawSearchState) {
      pendingLocalWrite.current = null;
      return;
    }
    if (pendingLocalWrite.current === true) return;
    if (serializedSearchState === serializedUrlState) return;

    applyingExternalState.current = serializedSearchState;
    setSortingRaw(urlState.sorting);
    setColumnFiltersRaw(urlState.columnFilters);
    setPaginationRaw(urlState.pagination);
  }, [
    urlSync,
    serializedRawSearchState,
    serializedSearchState,
    serializedUrlState,
    urlState,
  ]);

  useEffect(() => {
    if (!urlSync) return;
    if (applyingExternalState.current !== null) {
      if (serializedUrlState !== applyingExternalState.current) return;
      applyingExternalState.current = null;
      return;
    }
    if (serializedRawSearchState === serializedUrlState) {
      pendingLocalWrite.current = null;
      return;
    }
    if (pendingLocalWrite.current === serializedUrlState) return;
    pendingLocalWrite.current = serializedUrlState;
    const next = routerSearchSchema.parse(JSON.parse(serializedUrlState));
    void navigate({
      to: ".",
      search: (prev) => {
        const merged = routerSearchSchema.parse(prev);
        for (const key of managedKeys) {
          if (next[key] === undefined) delete merged[key];
          else merged[key] = next[key];
        }
        return merged;
      },
      replace: true,
    });
  }, [
    urlSync,
    serializedUrlState,
    serializedRawSearchState,
    managedKeys,
    navigate,
  ]);

  return useMemo(
    () => ({
      sorting,
      setSorting,
      columnFilters,
      allFilters,
      setColumnFilters,
      pagination,
      setPagination,
      getColumnFilter,
      getColumnFilterValues,
      getSortParams,
      getSorts,
      hasExplicitSort,
      hasPrimarySearch,
    }),
    [
      sorting,
      setSorting,
      columnFilters,
      allFilters,
      setColumnFilters,
      pagination,
      setPagination,
      getColumnFilter,
      getColumnFilterValues,
      getSortParams,
      getSorts,
      hasExplicitSort,
      hasPrimarySearch,
    ],
  );
}

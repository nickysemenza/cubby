import type { SortParams } from "@cubby/schemas/pagination";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  ColumnFiltersState,
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
import {
  decodeFilters,
  encodeFilters,
  type FilterSpecCore,
  partitionFilterSpecs,
} from "~/entities/filters";
import {
  buildSortParams,
  buildSortsParams,
  defaultPagination,
  defaultSortState,
} from "./tableUtils";

interface TableStateOptions {
  initialSort?: string;
  initialFilter?: ColumnFiltersState;
  initialPagination?: PaginationState;
  /**
   * The entity's filter manifest. When given (with `urlSync`), column filters
   * round-trip through the URL alongside sort/page — so a filtered view is
   * shareable and survives a reload, on every table rather than only the ones
   * that hand-rolled it.
   */
  filterSpecs?: readonly FilterSpecCore[];
  /**
   * Mirror sort + pagination to the URL search params (bookmarkable / shareable
   * / survives reload). Write-through is keyed on the serialized state, never
   * URL→state, so it can't render-loop. Enable on exactly one tableState per
   * page (the active data hook) — see useEntityList.
   */
  urlSync?: boolean;
  /**
   * Include pagination in URL sync. Infinite lists set this false because
   * their page index is an internal fetch cursor, not a user-visible page.
   */
  syncPaginationToUrl?: boolean;
}

/** Stable empty default (a fresh `[]` per render would churn the memos). */
const NO_SPECS: readonly FilterSpecCore[] = [];

// URL search keys for table state.
const SORT_KEY = "sort";
const PAGE_KEY = "page";
const SIZE_KEY = "pageSize";

/**
 * `[{id,desc},...]` → `name,-createdAt` (dash = descending); undefined if
 * empty. A single sort serializes byte-identically to the pre-multi-sort
 * format, so old URLs and the defaultSortParam comparison keep working.
 */
function sortToParam(sorting: SortingState): string | undefined {
  if (sorting.length === 0) return undefined;
  return sorting.map((s) => `${s.desc ? "-" : ""}${s.id}`).join(",");
}

/** `name,-createdAt` (or legacy single `name`/`-name`) → SortingState. */
function paramToSort(value: unknown): SortingState | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({
      id: t.startsWith("-") ? t.slice(1) : t,
      desc: t.startsWith("-"),
    }))
    .filter((s) => s.id);
  return parsed.length ? parsed : undefined;
}

export interface TableStateReturn {
  sorting: SortingState;
  setSorting: (
    value: SortingState | ((old: SortingState) => SortingState),
  ) => void;
  /**
   * The table's own filter state — column-backed specs only, so every entry
   * resolves to a real column. Feed this to TanStack.
   */
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
  /** Multi-value read for `multiselect` columns; scalars normalize to `[v]`. */
  getColumnFilterValues: (columnId: string) => string[] | undefined;
  /** Primary sort only — single-sort consumers (remote USDA list API). */
  getSortParams: () => SortParams;
  /** Full shift-click sort stack — the tRPC list input. */
  getSorts: () => SortParams[];
}

export function useTableState(
  options: TableStateOptions = {},
): TableStateReturn {
  const {
    initialSort = "createdAt",
    initialFilter = [],
    initialPagination = defaultPagination,
    filterSpecs = NO_SPECS,
    urlSync = false,
    syncPaginationToUrl = true,
  } = options;

  const [, startTransition] = useTransition();

  // A URL-only spec has no column to hold its value, so it's excluded from
  // every columnFilters-shaped path below (seed, encode, managed URL keys) —
  // the page that deep-links it owns that param and clears it by navigating.
  const [columnSpecs, urlOnlySpecs] = useMemo(
    () => partitionFilterSpecs(filterSpecs),
    [filterSpecs],
  );

  // Router hooks are called unconditionally (Rules of Hooks); their results are
  // only consumed when urlSync is on. useSearch(strict:false) works on any route.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();

  // Lazy initializers read the URL once (first render, incl. SSR) so a shared /
  // reloaded link restores sort + page before first paint. Reading is
  // unconditional (the keys are table-specific, absent on non-synced lists) —
  // only the write-back below is gated on urlSync. Reading regardless also fixes
  // the mobile case where the active hook flips after hydration (useIsMobile is
  // false at SSR), so its tableState must still honor the incoming params.
  const [sorting, setSortingRaw] = useState<SortingState>(() => {
    const fromUrl = paramToSort(search[SORT_KEY]);
    return fromUrl ?? defaultSortState(initialSort);
  });
  // Lazy initializer: URL filters win over the caller's seed, so a shared link
  // restores the same rows before first paint.
  const [columnFilters, setColumnFiltersRaw] = useState<ColumnFiltersState>(
    () => {
      const fromUrl = decodeFilters(columnSpecs, search);
      return fromUrl.length ? fromUrl : initialFilter;
    },
  );
  // URL-only scopes are read from the LIVE url rather than seeded into state:
  // the only way to change one is to navigate (the ScopeChip's clear), and the
  // list query has to follow that.
  const urlOnlyFilters = useMemo(
    () => decodeFilters(urlOnlySpecs, search),
    [urlOnlySpecs, search],
  );
  const allFilters = useMemo(
    () =>
      urlOnlyFilters.length
        ? [...columnFilters, ...urlOnlyFilters]
        : columnFilters,
    [columnFilters, urlOnlyFilters],
  );
  const [pagination, setPaginationRaw] = useState<PaginationState>(() => {
    const page = syncPaginationToUrl ? Number(search[PAGE_KEY]) : Number.NaN;
    const size = syncPaginationToUrl ? Number(search[SIZE_KEY]) : Number.NaN;
    return {
      pageIndex:
        Number.isFinite(page) && page > 0
          ? page - 1
          : initialPagination.pageIndex,
      pageSize:
        Number.isFinite(size) && size > 0 ? size : initialPagination.pageSize,
    };
  });

  // Wrap state setters in startTransition to prevent UI freezing
  const setSorting = useCallback(
    (value: SortingState | ((old: SortingState) => SortingState)) =>
      startTransition(() =>
        setSortingRaw(typeof value === "function" ? value : () => value),
      ),
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
        const next = typeof value === "function" ? value(old) : value;
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
          setPaginationRaw((p) =>
            p.pageIndex === 0 ? p : { ...p, pageIndex: 0 },
          );
        }
      }),
    [],
  );
  const setPagination = useCallback(
    (value: PaginationState | ((old: PaginationState) => PaginationState)) =>
      startTransition(() =>
        setPaginationRaw(typeof value === "function" ? value : () => value),
      ),
    [],
  );

  // Memoize getColumnFilter to prevent recreating on every render - CRITICAL
  const getColumnFilter = useCallback(
    (columnId: string): string | undefined => {
      const value = columnFilters.find(
        (filter) => filter.id === columnId,
      )?.value;
      // A multiselect column holds `string[]`. Returning it typed as `string`
      // would send an array to a scalar zod field and blow up at the tRPC
      // boundary at runtime instead of here — fail loudly at the call site
      // that forgot to switch to getColumnFilterValues.
      if (Array.isArray(value)) {
        throw new Error(
          `Column "${columnId}" holds a multi-value filter; use getColumnFilterValues.`,
        );
      }
      return value as string | undefined;
    },
    [columnFilters],
  );

  /** Multi-value counterpart, normalizing a scalar up into a one-element set. */
  const getColumnFilterValues = useCallback(
    (columnId: string): string[] | undefined => {
      const value = columnFilters.find(
        (filter) => filter.id === columnId,
      )?.value;
      if (Array.isArray(value))
        return value.length ? (value as string[]) : undefined;
      return typeof value === "string" && value ? [value] : undefined;
    },
    [columnFilters],
  );

  // Memoize getSortParams to prevent recreating on every render - CRITICAL
  const getSortParams = useCallback(() => {
    return buildSortParams(sorting, initialSort);
  }, [sorting, initialSort]);

  const getSorts = useCallback(() => {
    return buildSortsParams(sorting, initialSort);
  }, [sorting, initialSort]);

  // --- URL write-through (urlSync only) ------------------------------------
  // The default sort is descending on `initialSort` (see defaultSortState), so
  // that value is omitted from the URL to keep it clean. Serialize the
  // URL-relevant slice; the effect navigates only when this string changes —
  // it depends on STATE, not the URL, so writing the URL can't re-trigger it
  // (no render loop, even if the route's validateSearch strips the keys).
  const defaultSortParam = `-${initialSort}`;
  const serializedUrlState = useMemo(() => {
    const sortP = sortToParam(sorting);
    return JSON.stringify({
      ...encodeFilters(
        columnSpecs,
        (columnId) =>
          columnFilters.find((f) => f.id === columnId)?.value as
            | string
            | string[]
            | undefined,
      ),
      [SORT_KEY]: sortP === defaultSortParam ? undefined : sortP,
      [PAGE_KEY]:
        syncPaginationToUrl && pagination.pageIndex > 0
          ? pagination.pageIndex + 1
          : undefined,
      [SIZE_KEY]:
        syncPaginationToUrl &&
        pagination.pageSize !== defaultPagination.pageSize
          ? pagination.pageSize
          : undefined,
    });
  }, [
    sorting,
    pagination,
    columnFilters,
    columnSpecs,
    defaultSortParam,
    syncPaginationToUrl,
  ]);

  // Every key this hook owns. Enumerated rather than derived from `next`'s
  // own keys: JSON.stringify drops undefined, so a cleared filter is ABSENT
  // from `next` — iterating its keys could set and update a param but never
  // delete one. A URL-only key is deliberately absent: no column state can
  // produce it, so listing it here would delete it on the first write-through.
  const managedKeys = useMemo(
    () => [
      SORT_KEY,
      PAGE_KEY,
      SIZE_KEY,
      ...columnSpecs.map((spec) => spec.urlKey ?? spec.columnId),
    ],
    [columnSpecs],
  );

  const lastWrittenUrlState = useRef<string | null>(null);
  useEffect(() => {
    if (!urlSync) return;
    if (lastWrittenUrlState.current === serializedUrlState) return;
    lastWrittenUrlState.current = serializedUrlState;
    const next = JSON.parse(serializedUrlState) as Record<string, unknown>;
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        const merged = { ...prev };
        for (const key of managedKeys) {
          if (next[key] === undefined) delete merged[key];
          else merged[key] = next[key];
        }
        return merged;
      },
      replace: true,
    });
  }, [urlSync, serializedUrlState, managedKeys, navigate]);

  // Memoize the entire return object to prevent recreating on every render - CRITICAL
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
    ],
  );
}

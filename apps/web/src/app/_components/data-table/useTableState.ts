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
   * Mirror sort + pagination to the URL search params (bookmarkable / shareable
   * / survives reload). Write-through is keyed on the serialized state, never
   * URL→state, so it can't render-loop. Enable on exactly one tableState per
   * page (the active data hook) — see useEntityList.
   */
  urlSync?: boolean;
}

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
  columnFilters: ColumnFiltersState;
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
    urlSync = false,
  } = options;

  const [, startTransition] = useTransition();

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
  const [columnFilters, setColumnFiltersRaw] =
    useState<ColumnFiltersState>(initialFilter);
  const [pagination, setPaginationRaw] = useState<PaginationState>(() => {
    const page = Number(search[PAGE_KEY]);
    const size = Number(search[SIZE_KEY]);
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
  const setColumnFilters = useCallback(
    (
      value:
        | ColumnFiltersState
        | ((old: ColumnFiltersState) => ColumnFiltersState),
    ) =>
      startTransition(() =>
        setColumnFiltersRaw(typeof value === "function" ? value : () => value),
      ),
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
      [SORT_KEY]: sortP === defaultSortParam ? undefined : sortP,
      [PAGE_KEY]:
        pagination.pageIndex > 0 ? pagination.pageIndex + 1 : undefined,
      [SIZE_KEY]:
        pagination.pageSize !== defaultPagination.pageSize
          ? pagination.pageSize
          : undefined,
    });
  }, [sorting, pagination, defaultSortParam]);

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
        for (const key of [SORT_KEY, PAGE_KEY, SIZE_KEY]) {
          if (next[key] === undefined) delete merged[key];
          else merged[key] = next[key];
        }
        return merged;
      },
      replace: true,
    });
  }, [urlSync, serializedUrlState, navigate]);

  // Memoize the entire return object to prevent recreating on every render - CRITICAL
  return useMemo(
    () => ({
      sorting,
      setSorting,
      columnFilters,
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

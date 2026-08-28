import {
  act,
  renderHook as rtlRenderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FilterSpecCore } from "~/entities/filters";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { useTableState } from "./useTableState";

interface TableSearch {
  q?: string;
  trade?: string;
  sort?: string;
  page?: string;
  pageSize?: string;
  keep?: string;
  productId?: string;
  vendor?: string;
}

type TableSearchKey = keyof TableSearch;
const TABLE_SEARCH_KEYS: readonly TableSearchKey[] = [
  "q",
  "trade",
  "sort",
  "page",
  "pageSize",
  "keep",
  "productId",
  "vendor",
];

let searchState: TableSearch = {};

interface TableHarness {
  browser: ReturnType<typeof createBrowserTestHarness>;
  navigationCount: () => number;
  search: () => TableSearch;
  dispose: () => void;
}

let activeHarness: TableHarness | null = null;

function searchPath(search: TableSearch): string {
  const params = new URLSearchParams();
  for (const key of TABLE_SEARCH_KEYS) {
    const value = search[key];
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function readSearch(path: string): TableSearch {
  const params = new URL(path, "http://test.local").searchParams;
  const search: TableSearch = {};
  for (const key of TABLE_SEARCH_KEYS) {
    const value = params.get(key);
    if (value !== null) search[key] = value;
  }
  return search;
}

function createTableHarness(): TableHarness {
  const browser = createBrowserTestHarness({
    initialPath: searchPath(searchState),
  });
  let navigations = 0;
  const unsubscribe = browser.router.subscribe("onResolved", () => {
    navigations += 1;
  });
  const tableHarness: TableHarness = {
    browser,
    navigationCount: () => navigations,
    search: () => readSearch(browser.router.history.location.href),
    dispose: () => {
      unsubscribe();
      browser.dispose();
    },
  };
  activeHarness = tableHarness;
  return tableHarness;
}

function tableHarness(): TableHarness {
  if (!activeHarness) throw new Error("table harness has not been created");
  return activeHarness;
}

async function renderHookWithRouter(
  callback: () => ReturnType<typeof useTableState>,
): Promise<ReturnType<typeof renderHookWithRouterSync>> {
  const harness = createTableHarness();
  await harness.browser.router.load();
  return renderHookWithRouterSync(callback, harness);
}

function renderHookWithRouterSync(
  callback: () => ReturnType<typeof useTableState>,
  harness: TableHarness,
) {
  return {
    harness,
    ...rtlRenderHook(callback, {
      wrapper: harness.browser.wrapper,
    }),
  };
}

const renderHook = renderHookWithRouter;

async function navigateSearch(next: TableSearch): Promise<void> {
  searchState = next;
  await act(async () => {
    await tableHarness().browser.router.navigate({ to: searchPath(next) });
  });
}

afterEach(() => {
  activeHarness?.dispose();
  activeHarness = null;
});

const URL_BACKED_SPECS: readonly FilterSpecCore[] = [
  { columnId: "name", urlKey: "q", kind: "text" },
  { columnId: "trade", kind: "multiselect" },
];

describe("useTableState — pageIndex reset on filter change", () => {
  beforeEach(() => {
    searchState = {};
  });

  it("resets pageIndex to 0 when the filters actually change", async () => {
    const { result } = await renderHook(() =>
      useTableState({ initialPagination: { pageIndex: 2, pageSize: 20 } }),
    );
    expect(result.current.pagination.pageIndex).toBe(2);

    await act(async () => {
      result.current.setColumnFilters([{ id: "status", value: "active" }]);
    });

    expect(result.current.columnFilters).toEqual([
      { id: "status", value: "active" },
    ]);
    expect(result.current.pagination.pageIndex).toBe(0);
    // pageSize must stay untouched by the reset.
    expect(result.current.pagination.pageSize).toBe(20);
  });

  it("leaves pageIndex alone when the filter set is unchanged", async () => {
    const { result } = await renderHook(() =>
      useTableState({
        initialFilter: [{ id: "status", value: "active" }],
        initialPagination: { pageIndex: 2, pageSize: 20 },
      }),
    );
    expect(result.current.pagination.pageIndex).toBe(2);

    await act(async () => {
      result.current.setColumnFilters([{ id: "status", value: "active" }]);
    });

    expect(result.current.pagination.pageIndex).toBe(2);
  });

  it("resets pageIndex through the functional updater form too", async () => {
    const { result } = await renderHook(() =>
      useTableState({
        initialFilter: [{ id: "status", value: "active" }],
        initialPagination: { pageIndex: 3, pageSize: 20 },
      }),
    );

    await act(async () => {
      result.current.setColumnFilters((old) => [
        ...old,
        { id: "trade", value: "kitchen" },
      ]);
    });

    expect(result.current.columnFilters).toEqual([
      { id: "status", value: "active" },
      { id: "trade", value: "kitchen" },
    ]);
    expect(result.current.pagination.pageIndex).toBe(0);
  });

  it("a no-op functional updater (returns the same filters) does not reset the page", async () => {
    const { result } = await renderHook(() =>
      useTableState({
        initialFilter: [{ id: "status", value: "active" }],
        initialPagination: { pageIndex: 2, pageSize: 20 },
      }),
    );

    await act(async () => {
      result.current.setColumnFilters((old) => old);
    });

    expect(result.current.pagination.pageIndex).toBe(2);
  });

  it("restores a URL-seeded page on initial mount, unaffected by the reset", async () => {
    // A shared link (?page=3) must still land on page 3 — the reset only
    // applies to interactive filter changes made after mount, never to the
    // lazy URL initializers.
    searchState = { page: "3" };
    const { result } = await renderHook(() => useTableState());
    expect(result.current.pagination.pageIndex).toBe(2); // page=3 -> index 2
  });

  it("ignores and removes pagination URL state for infinite lists", async () => {
    searchState = { page: "4", pageSize: "100", keep: "yes" };
    const { result } = await renderHook(() =>
      useTableState({
        urlSync: true,
        syncPaginationToUrl: false,
        initialPagination: { pageIndex: 0, pageSize: 25 },
      }),
    );

    expect(result.current.pagination).toEqual({ pageIndex: 0, pageSize: 25 });
    await waitFor(() =>
      expect(tableHarness().search()).toEqual({ keep: "yes" }),
    );
  });

  it("ignores foreign URL state when an embedded table opts out of reads", async () => {
    searchState = {
      q: "project-only",
      sort: "startDate",
      page: "8",
      pageSize: "25",
    };

    const initialFilter = [{ id: "trade", value: ["electrical"] }];
    const { result } = await renderHook(() =>
      useTableState({
        initialSort: "dueDate",
        initialFilter,
        initialPagination: { pageIndex: 0, pageSize: 50 },
        filterSpecs: URL_BACKED_SPECS,
        urlSync: false,
        readUrlState: false,
      }),
    );
    const initialNavigationCount = tableHarness().navigationCount();

    expect(result.current.sorting).toEqual([{ id: "dueDate", desc: true }]);
    expect(result.current.columnFilters).toEqual(initialFilter);
    expect(result.current.allFilters).toBe(result.current.columnFilters);
    expect(result.current.pagination).toEqual({ pageIndex: 0, pageSize: 50 });
    expect(tableHarness().navigationCount()).toBe(initialNavigationCount);
  });

  it("keeps URL reads enabled when synchronization is on", async () => {
    searchState = { sort: "startDate", page: "3" };

    const { result } = await renderHook(() =>
      useTableState({
        initialSort: "dueDate",
        urlSync: true,
        readUrlState: false,
      }),
    );

    expect(result.current.sorting).toEqual([{ id: "startDate", desc: false }]);
    expect(result.current.pagination.pageIndex).toBe(2);
  });
});

describe("useTableState — URL-backed column filters", () => {
  beforeEach(() => {
    searchState = {};
  });

  it("initializes table filters from a shared URL", async () => {
    searchState = { q: "lemon", trade: "demo,electrical" };

    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );

    expect(result.current.columnFilters).toEqual([
      { id: "name", value: "lemon" },
      { id: "trade", value: ["demo", "electrical"] },
    ]);
  });

  it("writes interactive filters to the URL and removes cleared keys", async () => {
    searchState = { keep: "yes" };
    const { result, rerender } = await renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );

    await act(async () => {
      result.current.setColumnFilters([
        { id: "name", value: "lemon" },
        { id: "trade", value: ["demo", "electrical"] },
      ]);
    });
    await waitFor(() =>
      expect(tableHarness().search()).toEqual({
        keep: "yes",
        q: "lemon",
        trade: "demo,electrical",
      }),
    );

    // A real navigation has updated the router search before the user clears
    // the filter; model that acknowledgement before testing the next write.
    await navigateSearch({ keep: "yes", q: "lemon", trade: "demo,electrical" });
    rerender();
    await act(async () => {
      result.current.setColumnFilters([]);
    });
    await waitFor(() =>
      expect(tableHarness().search()).toEqual({ keep: "yes" }),
    );
  });

  it("reconciles same-route filter, sort, and page navigation after mount", async () => {
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    const initialNavigationCount = tableHarness().navigationCount();
    await navigateSearch({
      q: "lemon",
      trade: "demo,electrical",
      sort: "name,-createdAt",
      page: "3",
      pageSize: "50",
    });

    await waitFor(() =>
      expect(result.current).toMatchObject({
        sorting: [
          { id: "name", desc: false },
          { id: "createdAt", desc: true },
        ],
        columnFilters: [
          { id: "name", value: "lemon" },
          { id: "trade", value: ["demo", "electrical"] },
        ],
        pagination: { pageIndex: 2, pageSize: 50 },
      }),
    );
    expect(tableHarness().navigationCount()).toBe(initialNavigationCount + 1);
  });

  it("follows Back and Forward without writing the previous state back", async () => {
    searchState = { q: "first", sort: "name", page: "2" };
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    await navigateSearch({ q: "second", sort: "-createdAt", page: "4" });
    await waitFor(() => {
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "second" },
      ]);
      expect(result.current.pagination.pageIndex).toBe(3);
    });

    await navigateSearch({ q: "first", sort: "name", page: "2" });
    await waitFor(() => {
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "first" },
      ]);
      expect(result.current.sorting).toEqual([{ id: "name", desc: false }]);
      expect(result.current.pagination.pageIndex).toBe(1);
    });
    expect(tableHarness().navigationCount()).toBeGreaterThan(0);
  });

  it("treats a matching URL update as a local-write acknowledgement", async () => {
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    await act(async () => {
      result.current.setColumnFilters([{ id: "name", value: "lemon" }]);
    });
    await waitFor(() =>
      expect(tableHarness().navigationCount()).toBeGreaterThan(0),
    );

    await navigateSearch({ q: "lemon" });
    await waitFor(() =>
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "lemon" },
      ]),
    );
    expect(tableHarness().navigationCount()).toBeGreaterThan(0);
  });

  /**
   * `navigate` is async: the router publishes the new search a tick or more
   * after the write effect calls it, and this table re-renders freely in
   * between (a list refetch, a parent state change). Such a render must not be
   * mistaken for external navigation — doing so compared the just-applied
   * local state against the STALE url and wrote the OLD one back, which is
   * what made a saved view flash its filters into the URL and revert to
   * unfiltered.
   */
  it("survives re-renders between the write and the router acknowledging it", async () => {
    const { result, rerender } = await renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    await act(async () => {
      result.current.setColumnFilters([
        { id: "name", value: "lemon" },
        { id: "trade", value: ["demo"] },
      ]);
      result.current.setSorting([{ id: "name", desc: false }]);
    });
    await waitFor(() =>
      expect(tableHarness().navigationCount()).toBeGreaterThan(0),
    );

    rerender();
    rerender();

    expect(result.current.columnFilters).toEqual([
      { id: "name", value: "lemon" },
      { id: "trade", value: ["demo"] },
    ]);
    expect(result.current.sorting).toEqual([{ id: "name", desc: false }]);
    expect(tableHarness().navigationCount()).toBeGreaterThan(0);

    // The router finally publishes it: state stands, still no re-navigation.
    await navigateSearch({ q: "lemon", trade: "demo", sort: "name" });
    await waitFor(() =>
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "lemon" },
        { id: "trade", value: ["demo"] },
      ]),
    );
    expect(tableHarness().navigationCount()).toBeGreaterThan(0);
  });

  it("does not let a no-op local setter block later external navigation", async () => {
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );

    await act(async () => {
      result.current.setSorting((old) => old);
    });
    await navigateSearch({ q: "navigated", page: "2" });

    await waitFor(() => {
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "navigated" },
      ]);
      expect(result.current.pagination.pageIndex).toBe(1);
    });
  });
});

/**
 * A `urlOnly` spec (expenses' `?productId=` / `?order=`) has no table column.
 * Letting it into `columnFilters` made TanStack log
 * `[Table] Column with id 'productId' does not exist.` on every render, so it
 * is held apart — but it must still reach the server filters, and its URL param
 * must survive the write-through that owns the column-backed keys.
 */
describe("useTableState — URL-only filter specs", () => {
  const SPECS: readonly FilterSpecCore[] = [
    { columnId: "vendor", kind: "multiselect" },
    { columnId: "productId", kind: "id", urlOnly: true },
  ];

  beforeEach(() => {
    searchState = {};
  });

  it("keeps a URL-only scope out of columnFilters but in allFilters", async () => {
    searchState = { vendor: "Home Depot", productId: "prod-1" };
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: SPECS }),
    );

    expect(result.current.columnFilters).toEqual([
      { id: "vendor", value: ["Home Depot"] },
    ]);
    expect(result.current.allFilters).toEqual([
      { id: "vendor", value: ["Home Depot"] },
      { id: "productId", value: "prod-1" },
    ]);
  });

  it("hands back columnFilters itself when no URL-only scope is set", async () => {
    searchState = { vendor: "Home Depot" };
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: SPECS }),
    );

    expect(result.current.allFilters).toBe(result.current.columnFilters);
  });

  it("holds allFilters stable across a fresh search object with the same values", async () => {
    // The router reparses and hands back a NEW `search` object on every
    // navigation — including this hook's own write-through on any sort / page /
    // filter change. Keying the scope memo on that reference would churn
    // `allFilters` → the returned tableState → every memo downstream of it.
    searchState = { productId: "prod-1" };
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: SPECS }),
    );
    const first = result.current.allFilters;

    await navigateSearch({ productId: "prod-1" });

    expect(result.current.allFilters).toBe(first);
  });

  it("still follows the URL when a scope's value actually changes", async () => {
    searchState = { productId: "prod-1" };
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: SPECS }),
    );

    await navigateSearch({ productId: "prod-2" });

    expect(result.current.allFilters).toEqual([
      { id: "productId", value: "prod-2" },
    ]);
  });

  it("leaves the URL-only param alone on write-through", async () => {
    // No column state can produce `productId`, so the sync must not claim (and
    // therefore delete) its key — the ScopeChip's clear is the only writer.
    searchState = { productId: "prod-1" };
    const { result } = await renderHook(() =>
      useTableState({ filterSpecs: SPECS, urlSync: true }),
    );
    await act(async () => {
      result.current.setColumnFilters([
        { id: "vendor", value: ["Home Depot"] },
      ]);
    });
    await waitFor(() =>
      expect(tableHarness().search()).toMatchObject({
        productId: "prod-1",
        vendor: "Home Depot",
      }),
    );
  });
});

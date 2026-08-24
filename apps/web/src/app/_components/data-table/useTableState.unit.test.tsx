import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// useTableState calls useSearch({ strict: false }) unconditionally so URL-aware
// instances can seed state from shared links and URL writers can update them.
// Neither hook runs
// inside a RouterProvider here — mock both the same way
// inventory-entries-cell.unit.test.tsx mocks `Link`.
let mockSearch: Record<string, unknown> = {};
const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => mockSearch,
  useNavigate: () => mockNavigate,
}));

import type { FilterSpecCore } from "~/entities/filters";
import { useTableState } from "./useTableState";

const URL_BACKED_SPECS: readonly FilterSpecCore[] = [
  { columnId: "name", urlKey: "q", kind: "text" },
  { columnId: "trade", kind: "multiselect" },
];

describe("useTableState — pageIndex reset on filter change", () => {
  beforeEach(() => {
    mockSearch = {};
    mockNavigate.mockClear();
  });

  it("resets pageIndex to 0 when the filters actually change", async () => {
    const { result } = renderHook(() =>
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
    const { result } = renderHook(() =>
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
    const { result } = renderHook(() =>
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
    const { result } = renderHook(() =>
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

  it("restores a URL-seeded page on initial mount, unaffected by the reset", () => {
    // A shared link (?page=3) must still land on page 3 — the reset only
    // applies to interactive filter changes made after mount, never to the
    // lazy URL initializers.
    mockSearch = { page: "3" };
    const { result } = renderHook(() => useTableState());
    expect(result.current.pagination.pageIndex).toBe(2); // page=3 -> index 2
  });

  it("ignores and removes pagination URL state for infinite lists", async () => {
    mockSearch = { page: "4", pageSize: "100", keep: "yes" };
    const { result } = renderHook(() =>
      useTableState({
        urlSync: true,
        syncPaginationToUrl: false,
        initialPagination: { pageIndex: 0, pageSize: 25 },
      }),
    );

    expect(result.current.pagination).toEqual({ pageIndex: 0, pageSize: 25 });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    const navigateOptions = mockNavigate.mock.calls.at(-1)?.[0] as {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(navigateOptions.search(mockSearch)).toEqual({ keep: "yes" });
  });

  it("ignores foreign URL state when an embedded table opts out of reads", () => {
    mockSearch = {
      q: "project-only",
      sort: "startDate",
      page: "8",
      pageSize: "25",
    };

    const initialFilter = [{ id: "trade", value: ["electrical"] }];
    const { result } = renderHook(() =>
      useTableState({
        initialSort: "dueDate",
        initialFilter,
        initialPagination: { pageIndex: 0, pageSize: 50 },
        filterSpecs: URL_BACKED_SPECS,
        urlSync: false,
        readUrlState: false,
      }),
    );

    expect(result.current.sorting).toEqual([{ id: "dueDate", desc: true }]);
    expect(result.current.columnFilters).toEqual(initialFilter);
    expect(result.current.allFilters).toBe(result.current.columnFilters);
    expect(result.current.pagination).toEqual({ pageIndex: 0, pageSize: 50 });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("keeps URL reads enabled when synchronization is on", () => {
    mockSearch = { sort: "startDate", page: "3" };

    const { result } = renderHook(() =>
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
    mockSearch = {};
    mockNavigate.mockClear();
  });

  it("initializes table filters from a shared URL", () => {
    mockSearch = { q: "lemon", trade: "demo,electrical" };

    const { result } = renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );

    expect(result.current.columnFilters).toEqual([
      { id: "name", value: "lemon" },
      { id: "trade", value: ["demo", "electrical"] },
    ]);
  });

  it("writes interactive filters to the URL and removes cleared keys", async () => {
    const { result, rerender } = renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );

    await act(async () => {
      result.current.setColumnFilters([
        { id: "name", value: "lemon" },
        { id: "trade", value: ["demo", "electrical"] },
      ]);
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());

    const setOptions = mockNavigate.mock.calls.at(-1)?.[0] as {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(setOptions.search({ keep: "yes" })).toEqual({
      keep: "yes",
      q: "lemon",
      trade: "demo,electrical",
    });

    // A real navigation has updated the router search before the user clears
    // the filter; model that acknowledgement before testing the next write.
    mockSearch = { q: "lemon", trade: "demo,electrical" };
    rerender();
    mockNavigate.mockClear();
    await act(async () => {
      result.current.setColumnFilters([]);
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());

    const clearOptions = mockNavigate.mock.calls.at(-1)?.[0] as {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(
      clearOptions.search({
        keep: "yes",
        q: "lemon",
        trade: "demo,electrical",
      }),
    ).toEqual({ keep: "yes" });
  });

  it("reconciles same-route filter, sort, and page navigation after mount", async () => {
    const { result, rerender } = renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    mockNavigate.mockClear();

    mockSearch = {
      q: "lemon",
      trade: "demo,electrical",
      sort: "name,-createdAt",
      page: "3",
      pageSize: "50",
    };
    rerender();

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
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("follows Back and Forward without writing the previous state back", async () => {
    mockSearch = { q: "first", sort: "name", page: "2" };
    const { result, rerender } = renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    mockNavigate.mockClear();

    mockSearch = { q: "second", sort: "-createdAt", page: "4" };
    rerender();
    await waitFor(() => {
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "second" },
      ]);
      expect(result.current.pagination.pageIndex).toBe(3);
    });

    mockSearch = { q: "first", sort: "name", page: "2" };
    rerender();
    await waitFor(() => {
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "first" },
      ]);
      expect(result.current.sorting).toEqual([{ id: "name", desc: false }]);
      expect(result.current.pagination.pageIndex).toBe(1);
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("treats a matching URL update as a local-write acknowledgement", async () => {
    const { result, rerender } = renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    mockNavigate.mockClear();

    await act(async () => {
      result.current.setColumnFilters([{ id: "name", value: "lemon" }]);
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));

    mockSearch = { q: "lemon" };
    rerender();
    await waitFor(() =>
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "lemon" },
      ]),
    );
    expect(mockNavigate).toHaveBeenCalledTimes(1);
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
    const { result, rerender } = renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    mockNavigate.mockClear();

    await act(async () => {
      result.current.setColumnFilters([
        { id: "name", value: "lemon" },
        { id: "trade", value: ["demo"] },
      ]);
      result.current.setSorting([{ id: "name", desc: false }]);
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));

    rerender();
    rerender();

    expect(result.current.columnFilters).toEqual([
      { id: "name", value: "lemon" },
      { id: "trade", value: ["demo"] },
    ]);
    expect(result.current.sorting).toEqual([{ id: "name", desc: false }]);
    expect(mockNavigate).toHaveBeenCalledTimes(1);

    // The router finally publishes it: state stands, still no re-navigation.
    mockSearch = { q: "lemon", trade: "demo", sort: "name" };
    rerender();
    await waitFor(() =>
      expect(result.current.columnFilters).toEqual([
        { id: "name", value: "lemon" },
        { id: "trade", value: ["demo"] },
      ]),
    );
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it("does not let a no-op local setter block later external navigation", async () => {
    const { result, rerender } = renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );

    await act(async () => {
      result.current.setSorting((old) => old);
    });
    mockSearch = { q: "navigated", page: "2" };
    rerender();

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
    mockSearch = {};
    mockNavigate.mockClear();
  });

  it("keeps a URL-only scope out of columnFilters but in allFilters", () => {
    mockSearch = { vendor: "Home Depot", productId: "prod-1" };
    const { result } = renderHook(() => useTableState({ filterSpecs: SPECS }));

    expect(result.current.columnFilters).toEqual([
      { id: "vendor", value: ["Home Depot"] },
    ]);
    expect(result.current.allFilters).toEqual([
      { id: "vendor", value: ["Home Depot"] },
      { id: "productId", value: "prod-1" },
    ]);
  });

  it("hands back columnFilters itself when no URL-only scope is set", () => {
    mockSearch = { vendor: "Home Depot" };
    const { result } = renderHook(() => useTableState({ filterSpecs: SPECS }));

    expect(result.current.allFilters).toBe(result.current.columnFilters);
  });

  it("holds allFilters stable across a fresh search object with the same values", () => {
    // The router reparses and hands back a NEW `search` object on every
    // navigation — including this hook's own write-through on any sort / page /
    // filter change. Keying the scope memo on that reference would churn
    // `allFilters` → the returned tableState → every memo downstream of it.
    mockSearch = { productId: "prod-1" };
    const { result, rerender } = renderHook(() =>
      useTableState({ filterSpecs: SPECS }),
    );
    const first = result.current.allFilters;

    mockSearch = { productId: "prod-1" };
    rerender();

    expect(result.current.allFilters).toBe(first);
  });

  it("still follows the URL when a scope's value actually changes", () => {
    mockSearch = { productId: "prod-1" };
    const { result, rerender } = renderHook(() =>
      useTableState({ filterSpecs: SPECS }),
    );

    mockSearch = { productId: "prod-2" };
    rerender();

    expect(result.current.allFilters).toEqual([
      { id: "productId", value: "prod-2" },
    ]);
  });

  it("leaves the URL-only param alone on write-through", async () => {
    // No column state can produce `productId`, so the sync must not claim (and
    // therefore delete) its key — the ScopeChip's clear is the only writer.
    mockSearch = { productId: "prod-1" };
    const { result } = renderHook(() =>
      useTableState({ filterSpecs: SPECS, urlSync: true }),
    );
    await act(async () => {
      result.current.setColumnFilters([
        { id: "vendor", value: ["Home Depot"] },
      ]);
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));

    const call = mockNavigate.mock.calls[0]?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({ productId: "prod-1" })).toMatchObject({
      productId: "prod-1",
    });
  });
});

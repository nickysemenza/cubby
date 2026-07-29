import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// useTableState calls useSearch({ strict: false }) unconditionally (even when
// urlSync is off) so its lazy sort/filter/page initializers can read a shared
// link's URL params, and useNavigate() to write them back. Neither runs
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
      // Same value, re-set (e.g. re-applying an unchanged saved view).
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
    const { result } = renderHook(() =>
      useTableState({ filterSpecs: URL_BACKED_SPECS, urlSync: true }),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    mockNavigate.mockClear();

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
});

/**
 * A `urlOnly` spec (purchases' `?productId=` / `?order=`) has no table column.
 * Letting it into `columnFilters` made TanStack log
 * `[Table] Column with id 'productId' does not exist.` on every render, so it
 * is held apart — but it must still reach the server filters, and its URL param
 * must survive the write-through that owns the column-backed keys.
 */
describe("useTableState — URL-only filter specs", () => {
  // Module-level (stable reference): `filterSpecs` identity drives the memos.
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

    // Same reference, not just equal — a fresh array each render would churn
    // every memo keyed on the built filters.
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

  it("leaves the URL-only param alone on write-through", () => {
    // No column state can produce `productId`, so the sync must not claim (and
    // therefore delete) its key — the ScopeChip's clear is the only writer.
    mockSearch = { productId: "prod-1" };
    renderHook(() => useTableState({ filterSpecs: SPECS, urlSync: true }));

    const call = mockNavigate.mock.calls[0]?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({ productId: "prod-1" })).toMatchObject({
      productId: "prod-1",
    });
  });
});

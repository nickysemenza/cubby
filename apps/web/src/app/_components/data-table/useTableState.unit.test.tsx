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

import { useTableState } from "./useTableState";

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

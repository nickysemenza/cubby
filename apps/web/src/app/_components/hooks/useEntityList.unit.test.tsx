import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CubbyColumnDef as ColumnDef,
  CubbyTable as Table,
} from "../data-table/table-features";

interface TestRow {
  id: string;
}

interface CapturedTableOptions {
  getRowId?: (row: TestRow) => string;
  [key: string]: unknown;
}

const mocks = vi.hoisted(() => ({
  useTableConfig: vi.fn(
    (_options: CapturedTableOptions) => ({}) as Table<TestRow>,
  ),
  clearSelection: vi.fn(),
}));

vi.mock("@cubby/schemas/related-view", () => ({
  relatedViewRegistry: [],
  relatedViewsFor: () => [],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], isLoading: false }),
}));
// The hook reads search params directly (for the tab-title summary) rather than
// only through the mocked `useTableState`, so the router needs a stub here too —
// the real `useSearch` reaches into `router.stores` and there's no Router above
// this renderHook.
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({}),
}));
// Title wiring is a side effect on `document`, covered by tests/e2e/tab-title;
// stubbing it keeps this file about the table contract.
vi.mock("~/hooks/useDocumentTitle", () => ({
  useDocumentTitle: () => {},
}));
vi.mock("~/entities/entities", () => ({
  entities: {
    product: {
      pluralLabel: "Products",
      list: { hasUnitMappings: false, defaultSort: "name" },
    },
  },
}));
vi.mock("~/entities/filter-manifest", () => ({
  getEntityFilters: () => [],
}));
vi.mock("~/entities/filters", () => ({
  buildFiltersFromManifest: () => ({}),
  filterGetterFromColumnFilters: () => () => undefined,
  summarizeListState: () => undefined,
}));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    relatedData: { previews: { queryOptions: () => ({}) } },
  }),
}));
vi.mock("../data-table/useTableConfig", () => ({
  useTableConfig: mocks.useTableConfig,
}));
vi.mock("../data-table/useTableState", () => ({
  useTableState: () => ({
    sorting: [],
    setSorting: vi.fn(),
    columnFilters: [],
    allFilters: [],
    setColumnFilters: vi.fn(),
    pagination: { pageIndex: 0, pageSize: 25 },
    setPagination: vi.fn(),
    getColumnFilter: vi.fn(),
    getColumnFilterValues: vi.fn(),
    getSortParams: vi.fn(),
    getSorts: vi.fn(),
  }),
}));
vi.mock("./useInfiniteTableList", () => ({
  useInfiniteTableList: () => ({
    data: Array.from({ length: 200 }, (_, index) => ({ id: `row-${index}` })),
    totalCount: 500,
    sums: undefined,
    isLoading: false,
    error: null,
    timing: { durationMs: null, isFresh: false },
    infiniteScroll: {
      fetchNextPage: vi.fn(),
      hasNextPage: true,
      isFetchingNextPage: false,
      isTransitioning: false,
      loadAllPages: vi.fn(),
    },
    refreshControls: { onRefresh: vi.fn(), isRefreshing: false },
  }),
}));
vi.mock("./useListBulkActions", () => ({
  ListBulkActionBar: () => null,
  useListBulkActions: () => ({
    config: undefined,
    state: { clearSelection: mocks.clearSelection },
    enableRowSelection: false,
    rowSelection: {},
    onRowSelectionChange: undefined,
  }),
}));
vi.mock("./useOptimisticDelete", () => ({
  useOptimisticDelete: () => ({
    deleteBulkAction: undefined,
    combinedExtraActions: undefined,
    deleteDialog: null,
    requestDelete: vi.fn(),
  }),
}));
vi.mock("./useStandardColumns", () => ({
  useStandardColumns: () => [] as ColumnDef<TestRow>[],
}));

import { useClientEntityList } from "./useClientEntityList";
import { useEntityList } from "./useEntityList";

/**
 * `useClientEntityList` is a second entry point into the SAME table contract —
 * it differs only in where the rows come from (a prop, versus the server list
 * query). Anything both hooks must hand `useTableConfig` belongs here, run over
 * both, so a fix applied to one can't quietly skip the other.
 */
describe.each([
  [
    "useEntityList",
    () =>
      useEntityList<TestRow, Record<string, never>>({
        entity: "product",
        queryOptions: vi.fn(),
        buildFilters: () => ({}),
        columns: [],
      }),
  ],
  [
    "useClientEntityList",
    () =>
      useClientEntityList<TestRow>({
        entity: "product",
        data: [{ id: "PRD-TEST" }],
        columns: [],
      }),
  ],
] as const)("%s — shared table contract", (_name, render) => {
  beforeEach(() => mocks.useTableConfig.mockClear());

  it("passes a related-preview render version into the table contract", () => {
    renderHook(render);

    expect(mocks.useTableConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        rowContentVersion: expect.objectContaining({ loading: false }),
      }),
    );
  });
});

describe("useEntityList", () => {
  beforeEach(() => {
    mocks.useTableConfig.mockClear();
    mocks.clearSelection.mockClear();
  });

  it("does not re-paginate accumulated infinite-query rows", () => {
    renderHook(() =>
      useEntityList<TestRow, Record<string, never>>({
        entity: "product",
        queryOptions: vi.fn(),
        buildFilters: () => ({}),
        columns: [],
      }),
    );

    expect(mocks.useTableConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([{ id: "row-199" }]),
        totalCount: 200,
        manualPagination: true,
        initialColumnVisibility: {
          createdAt: false,
          updatedAt: false,
        },
      }),
    );
  });

  it("uses entity ids even when bulk selection is disabled", () => {
    renderHook(() =>
      useEntityList<TestRow, Record<string, never>>({
        entity: "product",
        queryOptions: vi.fn(),
        buildFilters: () => ({}),
        columns: [],
      }),
    );

    const options = mocks.useTableConfig.mock.calls[0]?.[0];
    expect(options?.getRowId?.({ id: "EXP-TEST" })).toBe("EXP-TEST");
  });

  it("clears bulk selection when the filter scope changes, but not initially", () => {
    const { rerender } = renderHook(
      ({ scope }) =>
        useEntityList<TestRow, { scope: string }>({
          entity: "product",
          queryOptions: vi.fn(),
          buildFilters: () => ({ scope }),
          columns: [],
        }),
      { initialProps: { scope: "first" } },
    );

    expect(mocks.clearSelection).not.toHaveBeenCalled();
    rerender({ scope: "second" });
    expect(mocks.clearSelection).toHaveBeenCalledTimes(1);
  });
});

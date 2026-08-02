import type { ColumnDef, Table } from "@tanstack/react-table";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestRow {
  id: string;
}

const mocks = vi.hoisted(() => ({
  useTableConfig: vi.fn(() => ({}) as Table<TestRow>),
}));

vi.mock("@cubby/schemas/related-view", () => ({ relatedViewRegistry: [] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], isLoading: false }),
}));
vi.mock("~/entities/entities", () => ({
  entities: {
    product: { list: { hasUnitMappings: false, defaultSort: "name" } },
  },
}));
vi.mock("~/entities/filter-manifest", () => ({
  getEntityFilters: () => [],
}));
vi.mock("~/entities/filters", () => ({
  buildFiltersFromManifest: () => ({}),
  filterGetterFromColumnFilters: () => () => undefined,
}));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    relatedData: { previews: { queryOptions: () => ({}) } },
  }),
}));
vi.mock("../data-table/useTableColumnVisibility", () => ({
  useTableColumnVisibility: () => ({
    columnVisibility: {},
    onColumnVisibilityChange: vi.fn(),
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
      loadAllPages: vi.fn(),
    },
    refreshControls: { onRefresh: vi.fn(), isRefreshing: false },
  }),
}));
vi.mock("./useListBulkActions", () => ({
  ListBulkActionBar: () => null,
  useListBulkActions: () => ({
    config: undefined,
    state: {},
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

import { useEntityList } from "./useEntityList";

describe("useEntityList", () => {
  beforeEach(() => mocks.useTableConfig.mockClear());

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
});

import type { ColumnDef, Table } from "@tanstack/react-table";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestRow {
  id: string;
}

const mocks = vi.hoisted(() => ({
  useTableConfig: vi.fn((_: unknown) => ({}) as Table<TestRow>),
  clearSelection: vi.fn(),
}));

vi.mock("@cubby/schemas/related-view", () => ({
  relatedViewRegistry: [],
  relatedViewsFor: () => [],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], isLoading: false }),
}));
vi.mock("~/entities/entities", () => ({
  entities: { product: { list: { defaultSort: "name" } } },
}));
vi.mock("~/entities/filter-manifest", () => ({ getEntityFilters: () => [] }));
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

describe("useClientEntityList", () => {
  beforeEach(() => mocks.useTableConfig.mockClear());

  it("passes a related-preview render version into the table contract", () => {
    renderHook(() =>
      useClientEntityList<TestRow>({
        entity: "product",
        data: [{ id: "PRD-TEST" }],
        columns: [],
      }),
    );

    expect(mocks.useTableConfig.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        rowContentVersion: expect.objectContaining({ loading: false }),
      }),
    );
  });
});

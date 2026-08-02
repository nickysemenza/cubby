import type { Table } from "@tanstack/react-table";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

interface TableOptions {
  getRowId?: (row: { fdc_id: number }) => string;
}

const mocks = vi.hoisted(() => ({
  useTableConfig: vi.fn((_options: TableOptions) => ({}) as Table<unknown>),
}));

vi.mock("~/lib/wasm", () => ({ wasm: {} }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    error: null,
    isFetching: false,
  }),
}));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    usda: {
      listSummaries: { queryOptions: vi.fn() },
      enrichmentsByID: { queryOptions: vi.fn() },
    },
  }),
}));
vi.mock("../_components/data-table/Table", () => ({ default: () => <div /> }));
vi.mock("../_components/data-table/useTableConfig", () => ({
  useTableConfig: mocks.useTableConfig,
}));
vi.mock("../_components/data-table/useTableState", () => ({
  useTableState: () => ({
    getColumnFilter: () => undefined,
    getSortParams: () => ({ orderBy: "fdc_id", direction: "asc" }),
    pagination: { pageIndex: 0, pageSize: 25 },
  }),
}));
vi.mock("../_components/hooks/useEntityPreview", () => ({
  useEntityPreview: () => ({
    onRowClick: vi.fn(),
    onRowHover: vi.fn(),
    PreviewSheet: () => null,
  }),
}));
vi.mock("../_components/data-table/columnHelpers", () => ({
  createEntityInlineLinkColumn: () => ({}),
}));

import { USDAFoodList } from "./usdafoodlist";

describe("USDAFoodList", () => {
  it("uses FDC ids as stable TanStack row identities", () => {
    render(<USDAFoodList />);

    const options = mocks.useTableConfig.mock.calls[0]?.[0];
    expect(options?.getRowId?.({ fdc_id: 12345 })).toBe("12345");
  });
});

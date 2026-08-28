import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createCubbyColumnHelper } from "../data-table/table-features";

const queryState = vi.hoisted(() => ({
  current: { data: undefined as unknown, isLoading: true },
  queryOptions: vi.fn((input: unknown) => ({
    queryKey: ["related-previews", input],
  })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState.current,
}));
vi.mock("~/lib/related-data.functions", () => ({
  relatedData: { previews: { queryOptions: queryState.queryOptions } },
}));
vi.mock("~/entities/entities", () => ({
  getSortableFields: () => [],
}));
vi.mock("~/entities/filter-manifest", () => ({
  manifestFilterConfig: () => undefined,
}));

import { useRelatedPreviewColumns } from "./useRelatedPreviewColumns";

interface TestRow {
  id: string;
}

const columnHelper = createCubbyColumnHelper<TestRow>();
const relatedViews = [
  {
    key: "product.vendors",
    source: "product" as const,
    target: "vendor" as const,
    label: "Vendors",
    defaultVisible: true,
    order: "alphabetical" as const,
    path: [],
  },
];

describe("useRelatedPreviewColumns", () => {
  it("keeps columns stable while preview loading resolves through its render version", () => {
    const { result, rerender } = renderHook(() =>
      useRelatedPreviewColumns({
        entity: "product",
        sourceIds: ["PRD-TEST"],
        visibleRelationKeys: ["product.vendors"],
        relatedViews,
        columnHelper,
        supportsServerSorting: true,
      }),
    );
    const loadingColumns = result.current.relatedColumns;
    const loadingVersion = result.current.rowContentVersion;

    queryState.current = {
      isLoading: false,
      data: [
        {
          sourceId: "PRD-TEST",
          relationKey: "product.vendors",
          totalCount: 1,
          items: [{ entity: "vendor", id: "VEN-TEST", label: "Moore Newton" }],
        },
      ],
    };
    rerender();

    expect(queryState.queryOptions).toHaveBeenLastCalledWith({
      source: "product",
      sourceIds: ["PRD-TEST"],
      relationKeys: ["product.vendors"],
    });
    expect(result.current.relatedColumns).toBe(loadingColumns);
    expect(result.current.rowContentVersion).not.toBe(loadingVersion);
    const cell = result.current.relatedColumns[0]?.cell;
    expect(typeof cell).toBe("function");
    const rendered = (cell as (context: unknown) => { props: unknown })({
      row: { original: { id: "PRD-TEST" } },
    });
    expect(rendered.props).toEqual(
      expect.objectContaining({
        loading: false,
        group: expect.objectContaining({
          items: [expect.objectContaining({ label: "Moore Newton" })],
        }),
      }),
    );
  });
});

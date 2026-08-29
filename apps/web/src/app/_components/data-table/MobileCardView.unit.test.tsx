import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileCardView } from "./MobileCardView";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "./table-features";

interface TestRow {
  id: string;
  toolName: string;
}

describe("MobileCardView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards a non-entity row click to the shared RTable callback", () => {
    class TestIntersectionObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    const helper = createCubbyColumnHelper<TestRow>();
    const columns = createCubbyColumnCollection<TestRow>((add) => {
      add(
        helper.accessor("toolName", {
          header: "Tool",
          meta: { mobile: { slot: "title" } },
        }),
      );
    });
    const { result } = renderHook(() =>
      useCubbyTable({
        data: [{ id: "tool-1", toolName: "list_products" }],
        columns: materializeCubbyColumns(columns),
        getRowId: (row) => row.id,
        enableRowSelection: false,
      }),
    );
    const onRowClick = vi.fn();

    render(<MobileCardView table={result.current} onRowClick={onRowClick} />);
    expect(screen.getByText("list_products")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("group"));

    expect(onRowClick).toHaveBeenCalledOnce();
    expect(onRowClick.mock.calls[0]?.[0].original).toEqual({
      id: "tool-1",
      toolName: "list_products",
    });
  });
});

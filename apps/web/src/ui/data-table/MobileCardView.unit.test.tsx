import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { MobileCardView } from "./MobileCardView";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "./table-features";

interface ToolRow {
  id: string;
  toolName: string;
}

interface ProductRow {
  id: string;
  name: string;
  category: string;
  vendor: string;
  quantity: number;
}

/** A title/subtitle/meta/trailing table shaped like the phone-list canvas row. */
function buildProductTable(rows: ProductRow[]) {
  const helper = createCubbyColumnHelper<ProductRow>();
  const columns = createCubbyColumnCollection<ProductRow>((add) => {
    add(
      helper.accessor("name", {
        header: "Name",
        meta: { mobile: { slot: "title" } },
      }),
    );
    add(
      helper.accessor("category", {
        header: "Category",
        meta: { mobile: { slot: "subtitle", priority: 10 } },
      }),
    );
    add(
      helper.accessor("vendor", {
        header: "Vendor",
        meta: { mobile: { slot: "meta", priority: 20 } },
      }),
    );
    add(
      helper.accessor("quantity", {
        header: "Qty",
        meta: { mobile: { slot: "trailing" } },
      }),
    );
  });
  const { result } = renderHook(() =>
    useCubbyTable({
      data: rows,
      columns: materializeCubbyColumns(columns),
      getRowId: (row) => row.id,
      enableRowSelection: false,
    }),
  );
  return result.current;
}

beforeEach(() => {
  // The virtualizer and the infinite-scroll sentinel both need this; jsdom has
  // no IntersectionObserver.
  class TestIntersectionObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

describe("MobileCardView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards a non-entity row click to the shared RTable callback", () => {
    const helper = createCubbyColumnHelper<ToolRow>();
    const columns = createCubbyColumnCollection<ToolRow>((add) => {
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
    fireEvent.click(screen.getByRole("button"));

    expect(onRowClick).toHaveBeenCalledOnce();
    expect(onRowClick.mock.calls[0]?.[0].original).toEqual({
      id: "tool-1",
      toolName: "list_products",
    });
  });

  it("activates the non-link fallback row from the keyboard", () => {
    // Regression: a clickable `<div>` row needs its own keydown handling to
    // stay operable without a mouse — see jsx-a11y/click-events-have-key-events.
    const helper = createCubbyColumnHelper<ToolRow>();
    const columns = createCubbyColumnCollection<ToolRow>((add) => {
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
    const rowButton = screen.getByRole("button");
    expect(rowButton).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(rowButton, { key: "Enter" });

    expect(onRowClick).toHaveBeenCalledOnce();
  });

  it("joins the subtitle- and meta-slot values into one ` · `-separated line", () => {
    const table = buildProductTable([
      {
        id: "prod-1",
        name: "Organic Rolled Oats",
        category: "Grains",
        vendor: "Example Mills",
        quantity: 3,
      },
    ]);

    render(<MobileCardView table={table} />);

    // The stacked label/value spec grid is gone — subtitle and meta collapse
    // into one truncated identity line, joined by a middle dot.
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "Grains · Example Mills",
      ),
    ).toBeInTheDocument();
  });

  it("renders the trailing value with tabular figures so amounts align", () => {
    const table = buildProductTable([
      {
        id: "prod-1",
        name: "Organic Rolled Oats",
        category: "Grains",
        vendor: "Example Mills",
        quantity: 3,
      },
    ]);

    render(<MobileCardView table={table} />);

    expect(screen.getByText("3")).toHaveClass("tabular-nums");
  });

  it("renders the row as a link to its details href", () => {
    const harness = createBrowserTestHarness();
    const table = buildProductTable([
      {
        id: "prod-1",
        name: "Organic Rolled Oats",
        category: "Grains",
        vendor: "Example Mills",
        quantity: 3,
      },
    ]);

    render(
      <MobileCardView
        table={table}
        getDetailsHref={(row) => `/products/${row.id}`}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/products/prod-1",
    );
    harness.dispose();
  });
});

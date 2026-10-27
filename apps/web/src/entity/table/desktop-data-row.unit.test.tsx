import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { StackedValue } from "../../ui/common/stacked-value";
import { CellEditTrigger } from "../../ui/data-table/cell-edit-trigger";
import { useRowActive } from "../../ui/data-table/row-activity";
import { buildSelectColumn } from "../../ui/data-table/row-selection";
import type { CubbyRow as Row } from "../../ui/data-table/table-features";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "../../ui/data-table/table-features";
import type { CubbyColumnMeta } from "../../ui/data-table/table-meta";
import { DesktopDataRow, type DesktopDataRowProps } from "./desktop-data-row";

interface TestRow {
  id: string;
}

const columnHelper = createCubbyColumnHelper<TestRow>();

function useTestTable(
  cell?: () => ReactNode,
  options: {
    id?: string;
    header?: string;
    meta?: CubbyColumnMeta;
  } = {},
) {
  const columns = createCubbyColumnCollection<TestRow>((add) => {
    add(
      columnHelper.accessor("id", {
        id: options.id ?? "related:product.vendors",
        header: options.header ?? "Vendors",
        cell,
        meta: options.meta,
      }),
    );
  });
  return useCubbyTable({
    data: [{ id: "PRD-TEST" }],
    columns: materializeCubbyColumns(columns),
    getRowId: (row) => row.id,
  });
}

type RowOverrides = Partial<Omit<DesktopDataRowProps<TestRow>, "row">>;

function desktopRowProps(row: Row<TestRow>, overrides: RowOverrides = {}) {
  return {
    row,
    rowIndex: 0,
    isSelected: false,
    isCurrent: false,
    isExpanded: false,
    isFocused: false,
    isDebugEnabled: false,
    rowClassName: "",
    cellClassName: "",
    columnsKey: "",
    ...overrides,
  };
}

describe("DesktopDataRow", () => {
  it.each([true, false])(
    "keeps secondary values only in non-identity cells (identity: %s)",
    (identity) => {
      const { result } = renderHook(() =>
        useTestTable(
          () => (
            <StackedValue
              primary="Synthetic name"
              secondary="Synthetic context"
            />
          ),
          {
            id: "name",
            meta: identity ? { entityColumnRole: "identity" } : {},
          },
        ),
      );
      render(
        <table>
          <tbody>
            <DesktopDataRow
              {...desktopRowProps(result.current.getRow("PRD-TEST"))}
            />
          </tbody>
        </table>,
      );
      expect(screen.getByText("Synthetic name")).toBeVisible();
      expect(screen.queryByText("Synthetic context") !== null).toBe(!identity);
    },
  );

  const inspectableProvenance = {
    kind: "derived",
    sources: [
      {
        entity: "financialTransaction",
        label: null,
        relation: "financial-transactions",
      },
    ],
  } satisfies EntityFieldProvenance;

  it("keeps provenance-backed non-image cells in the relation workbench", () => {
    const { result } = renderHook(() =>
      useTestTable(() => <span>Vendor count</span>, {
        meta: {
          mobile: { slot: "meta" },
          provenance: inspectableProvenance,
        },
      }),
    );
    const row = result.current.getRow("PRD-TEST");

    render(
      <table>
        <tbody>
          <DesktopDataRow {...desktopRowProps(row)} />
        </tbody>
      </table>,
    );

    expect(screen.getByText("Vendor count")).toBeVisible();
    fireEvent.pointerEnter(screen.getByRole("row"), { pointerType: "mouse" });
    // The rail belongs to the hovered cell, not every cell of the active row.
    expect(
      screen.queryByRole("button", { name: "Inspect related records" }),
    ).not.toBeInTheDocument();
    fireEvent.pointerEnter(screen.getByRole("cell"), { pointerType: "mouse" });
    expect(
      screen.getByRole("button", { name: "Inspect related records" }),
    ).toBeVisible();
  });

  it("re-renders memoized cells when external row content changes", () => {
    let preview = "…";
    const { result } = renderHook(() => useTestTable(() => preview));
    const row = result.current.getRow("PRD-TEST");
    const props = desktopRowProps(row, {
      columnsKey: "related:product.vendors",
    });
    const { rerender } = render(
      <table>
        <tbody>
          <DesktopDataRow {...props} rowContentVersion={{}} />
        </tbody>
      </table>,
    );

    expect(screen.getByText("…")).toBeInTheDocument();
    preview = "Moore Newton";
    rerender(
      <table>
        <tbody>
          <DesktopDataRow {...props} rowContentVersion={{}} />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Moore Newton")).toBeInTheDocument();
  });

  it("uses pointer and keyboard intent but does not speculate on touch", () => {
    const onRowClick = vi.fn();
    const onRowHover = vi.fn();
    const onRowHoverEnd = vi.fn();
    const { result } = renderHook(() => useTestTable());
    const row = result.current.getRow("PRD-TEST");
    render(
      <table>
        <tbody>
          <DesktopDataRow
            {...desktopRowProps(row, {
              onRowClick,
              onRowHover,
              onRowHoverEnd,
            })}
          />
        </tbody>
      </table>,
    );

    const renderedRow = screen.getByRole("row");
    fireEvent.pointerEnter(renderedRow, { pointerType: "mouse" });
    fireEvent.pointerLeave(renderedRow, { pointerType: "mouse" });
    fireEvent.focus(renderedRow);
    fireEvent.blur(renderedRow);
    fireEvent.pointerEnter(renderedRow, { pointerType: "touch" });
    fireEvent.pointerLeave(renderedRow, { pointerType: "touch" });
    fireEvent.click(renderedRow);

    expect(onRowHover).toHaveBeenCalledTimes(2);
    expect(onRowHoverEnd).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenCalledOnce();
  });

  it("opens inspection from the identity while preserving fact cells, edit controls, and modified links", () => {
    const inspect = vi.fn();
    const columns = columnHelper.columns([
      columnHelper.accessor("id", {
        id: "identity",
        meta: { entityColumnRole: "identity" },
        cell: () => (
          <>
            <span data-record-identity-link>
              <a href="#full-record">Sample record</a>
            </span>
            <button type="button" data-cell-edit-trigger>
              Edit name
            </button>
          </>
        ),
      }),
      columnHelper.accessor("id", {
        id: "fact",
        meta: { entityColumnRole: "fact" },
        cell: () => <span>Recorded fact</span>,
      }),
    ]);
    const { result } = renderHook(() =>
      useCubbyTable({
        data: [{ id: "synthetic-record" }],
        columns,
        getRowId: (row) => row.id,
      }),
    );
    render(
      <table>
        <tbody>
          <DesktopDataRow
            {...desktopRowProps(result.current.getRow("synthetic-record"), {
              onRowClick: inspect,
            })}
          />
        </tbody>
      </table>,
    );
    fireEvent.click(screen.getByText("Recorded fact"));
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    fireEvent.click(screen.getByRole("link", { name: "Sample record" }), {
      metaKey: true,
    });
    expect(inspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Sample record" }));
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("does not open the row inspector from an interactive cell control", () => {
    const onRowClick = vi.fn();
    const buttonClick = vi.fn();
    const { result } = renderHook(() =>
      useTestTable(() => (
        <button type="button" onClick={buttonClick}>
          <svg aria-label="Settlement icon">
            <path d="M0 0h1" />
          </svg>
          Inspect settlement
        </button>
      )),
    );
    const row = result.current.getRow("PRD-TEST");

    render(
      <table>
        <tbody>
          <DesktopDataRow
            {...desktopRowProps(row, {
              onRowClick,
            })}
          />
        </tbody>
      </table>,
    );

    fireEvent.click(screen.getByLabelText("Settlement icon"));

    expect(buttonClick).toHaveBeenCalledOnce();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does not replace an interactive control with a hover inspector", () => {
    const onRowHover = vi.fn();
    const { result } = renderHook(() =>
      useTestTable(() => <button type="button">Inspect settlement</button>),
    );
    const row = result.current.getRow("PRD-TEST");

    render(
      <table>
        <tbody>
          <DesktopDataRow
            {...desktopRowProps(row, {
              onRowHover,
            })}
          />
        </tbody>
      </table>,
    );

    const button = screen.getByRole("button", { name: "Inspect settlement" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.focus(button);

    expect(onRowHover).not.toHaveBeenCalled();
  });

  it("marks the inspector's current record without changing bulk selection", () => {
    const { result } = renderHook(() => useTestTable());
    const row = result.current.getRow("PRD-TEST");

    render(
      <table>
        <tbody>
          <DesktopDataRow {...desktopRowProps(row, { isCurrent: true })} />
        </tbody>
      </table>,
    );

    const renderedRow = screen.getByRole("row");
    expect(renderedRow).toHaveAttribute("data-current", "true");
    expect(renderedRow).toHaveAttribute("aria-current", "true");
    expect(renderedRow).not.toHaveAttribute("data-state", "selected");
  });

  // Regression class: a cell whose tree shape depended on row activity
  // remounted its content on every hover, dropping focus inside it and (for
  // the selection checkbox) swallowing the click. Activity may only swap a
  // trailing leaf; every content node keeps its identity.
  it("keeps every cell's content mounted as row activity changes", () => {
    const { result } = renderHook(() =>
      useCubbyTable({
        data: [{ id: "PRD-TEST" }],
        columns: materializeCubbyColumns(
          createCubbyColumnCollection<TestRow>((add) => {
            add(buildSelectColumn<TestRow>());
            add(
              columnHelper.accessor("id", {
                id: "related:product.vendors",
                header: "Vendors",
                cell: () => <a href="/vendors">Vendor count</a>,
                meta: { provenance: inspectableProvenance },
              }),
            );
            add(
              columnHelper.display({
                id: "name",
                header: "Name",
                cell: () => (
                  <CellEditTrigger onStartEdit={() => undefined}>
                    Synthetic name
                  </CellEditTrigger>
                ),
              }),
            );
          }),
        ),
        getRowId: (row) => row.id,
        enableRowSelection: true,
      }),
    );
    const row = result.current.getRow("PRD-TEST");
    render(
      <table>
        <tbody>
          <DesktopDataRow {...desktopRowProps(row)} />
        </tbody>
      </table>,
    );
    const nodes = [
      screen.getByRole("checkbox", { name: "Select row" }),
      screen.getByRole("link", { name: "Vendor count" }),
      screen.getByText("Synthetic name"),
    ];
    const renderedRow = screen.getByRole("row");
    fireEvent.pointerEnter(renderedRow, { pointerType: "mouse" });
    const vendorCell = screen
      .getByRole("link", { name: "Vendor count" })
      .closest("td");
    if (!vendorCell) throw new Error("Expected the vendor cell");
    fireEvent.pointerEnter(vendorCell, { pointerType: "mouse" });
    expect(
      screen.getByRole("button", { name: "Inspect related records" }),
    ).toBeVisible();
    fireEvent.pointerLeave(renderedRow, { pointerType: "mouse" });
    fireEvent.focus(renderedRow);
    for (const node of nodes) expect(node.isConnected).toBe(true);
  });

  it("keeps affordances mounted outside a table row", () => {
    function Affordance() {
      return useRowActive() ? <button type="button">Edit</button> : null;
    }
    render(<Affordance />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});

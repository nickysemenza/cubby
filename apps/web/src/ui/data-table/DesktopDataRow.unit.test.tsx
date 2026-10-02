import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CellEditTrigger } from "./cell-edit-trigger";
import { DesktopDataRow, type DesktopDataRowProps } from "./DesktopDataRow";
import {
  createRowActivityStore,
  RowActivityStoreContext,
  useRowActive,
} from "./row-activity";
import { buildSelectColumn } from "./row-selection";
import type { CubbyRow as Row } from "./table-features";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "./table-features";
import type { CubbyColumnMeta } from "./table-meta";
import TableHeaderLayout from "./TableHeaderLayout";

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

  it("renders provenance-backed image previews directly while keeping header provenance", () => {
    const { result } = renderHook(() =>
      useTestTable(
        () => (
          <button type="button" aria-label="Preview image">
            Thumbnail
          </button>
        ),
        {
          id: "image",
          header: "Image",
          meta: {
            mobile: { slot: "image" },
            provenance: inspectableProvenance,
          },
        },
      ),
    );
    const row = result.current.getRow("PRD-TEST");

    render(
      <table>
        <thead>
          <TableHeaderLayout
            table={result.current}
            styles={{ header: "", sortIcon: "" }}
            isDebugEnabled={false}
          />
        </thead>
        <tbody>
          <DesktopDataRow {...desktopRowProps(row)} />
        </tbody>
      </table>,
    );

    expect(
      screen.getByRole("button", { name: "Preview image" }),
    ).toHaveTextContent("Thumbnail");
    expect(
      screen.queryByRole("button", { name: "Inspect related records" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("note", { name: "From Transactions" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Sort by Image" }),
    ).toHaveTextContent("Image");
  });

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

  it("does not open the row inspector from an interactive cell control", () => {
    const onRowClick = vi.fn();
    const buttonClick = vi.fn();
    const { result } = renderHook(() =>
      useTestTable(() => (
        <button type="button" onClick={buttonClick}>
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

    fireEvent.click(screen.getByRole("button", { name: "Inspect settlement" }));

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

  // Failures: every idle row mounting hover-only controls (the DOM weight that
  // made long tables lag), hover/keyboard focus never revealing them, the
  // inspector's current row losing them, or leaving a row (into a popover one
  // of its controls opened) unmounting that control.
  it("mounts hover-only cell affordances on the table's one active row", () => {
    function Affordance() {
      return useRowActive() ? <button type="button">Edit</button> : null;
    }
    const { result } = renderHook(() =>
      useCubbyTable({
        data: [{ id: "PRD-AAAA" }, { id: "PRD-BBBB" }],
        columns: materializeCubbyColumns(
          createCubbyColumnCollection<TestRow>((add) => {
            add(
              columnHelper.accessor("id", {
                id: "name",
                header: "Name",
                cell: () => <Affordance />,
              }),
            );
          }),
        ),
        getRowId: (row) => row.id,
      }),
    );
    const view = (current?: string) => (
      <RowActivityStoreContext value={store}>
        <table>
          <tbody>
            {["PRD-AAAA", "PRD-BBBB"].map((id, index) => (
              <DesktopDataRow
                key={id}
                {...desktopRowProps(result.current.getRow(id), {
                  rowIndex: index,
                  isCurrent: current === id,
                })}
              />
            ))}
          </tbody>
        </table>
      </RowActivityStoreContext>
    );
    const store = createRowActivityStore();
    const { rerender } = render(view());
    const [first, second] = screen.getAllByRole("row");
    const edits = () => screen.queryAllByRole("button", { name: "Edit" });
    expect(edits()).toHaveLength(0);

    fireEvent.pointerEnter(first!, { pointerType: "mouse" });
    expect(edits()).toHaveLength(1);
    fireEvent.pointerLeave(first!, { pointerType: "mouse" });
    expect(edits()).toHaveLength(1);
    fireEvent.pointerEnter(second!, { pointerType: "mouse" });
    expect(within(second!).getByRole("button", { name: "Edit" })).toBeVisible();
    expect(edits()).toHaveLength(1);

    fireEvent.focus(first!);
    expect(within(first!).getByRole("button", { name: "Edit" })).toBeVisible();
    expect(edits()).toHaveLength(1);

    rerender(view("PRD-BBBB"));
    expect(edits()).toHaveLength(2);
  });

  // Regression: flipping row activity while the selection checkbox held focus
  // remounted it between mousedown and mouseup, so the click never toggled.
  it("does not activate the row when focus lands on a control inside it", () => {
    function Cell() {
      const active = useRowActive();
      return (
        <>
          <input type="checkbox" aria-label="Select row" />
          {active ? <button type="button">Edit</button> : null}
        </>
      );
    }
    const { result } = renderHook(() => useTestTable(() => <Cell />));
    const row = result.current.getRow("PRD-TEST");
    render(
      <RowActivityStoreContext value={createRowActivityStore()}>
        <table>
          <tbody>
            <DesktopDataRow {...desktopRowProps(row)} />
          </tbody>
        </table>
      </RowActivityStoreContext>,
    );
    const checkbox = screen.getByRole("checkbox");
    fireEvent.focus(checkbox);
    expect(screen.getByRole("checkbox")).toBe(checkbox);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
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

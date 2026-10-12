import { flexRender } from "@tanstack/react-table";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { householdDaysFromNow } from "~/lib/household-date";
import { Badge } from "~/ui/primitives/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from "~/ui/primitives/table";

import { CellFrame, CELL_RAIL_BUTTON_CLASS } from "./cell-frame";
import { useTableColumnLayout } from "./column-layout";
import {
  columnWidthVariables,
  columnWidthValue,
  columnOffsetValue,
  resolvedTableColumnWidths,
} from "./column-layout";
import { createPlainDateColumn } from "./columnHelpers";
import { ROW_DENSITY } from "./density";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "./table-features";
import { useRenderedColumnWidths } from "./useRenderedColumnWidths";

const helper = createCubbyColumnHelper<{ id: string }>();
const columns = helper.columns([
  helper.display({
    id: "quality",
    header: "Quality",
    size: 160,
    minSize: 48,
    maxSize: 180,
  }),
  helper.display({
    id: "location",
    header: "Location",
    size: 184,
    minSize: 48,
    maxSize: 200,
  }),
]);

function FitFixture({
  location = "Studio",
  scope = "first",
  pinned = false,
  icon = false,
  total = "Total",
}: {
  location?: string;
  scope?: string;
  pinned?: boolean;
  icon?: boolean;
  total?: string;
}) {
  const table = useCubbyTable({
    data: [{ id: "synthetic" }],
    columns,
    getRowId: (row) => row.id,
    initialState: {
      columnPinning: { start: pinned ? ["quality", "location"] : [], end: [] },
    },
  });
  const ref = useRef<HTMLDivElement>(null);
  const measured = useRenderedColumnWidths(table, ref, scope, true);
  const manual = new Set(Object.keys(table.state.columnSizing ?? {}));
  const fitted = resolvedTableColumnWidths(
    table.getVisibleLeafColumns(),
    0,
    manual,
    measured,
  );
  const totalWidth = Object.values(fitted.widths).reduce(
    (sum, value) => sum + value,
    0,
  );
  const cellStyle = (id: string) => {
    const style: React.CSSProperties = { width: columnWidthValue(id) };
    if (pinned) {
      style.position = "sticky";
      style.insetInlineStart = columnOffsetValue(
        table.getStartVisibleLeafColumns(),
        id,
        "start",
      );
    }
    return style;
  };
  return (
    <>
      <button
        type="button"
        onClick={() => table.setColumnSizing({ location: 151 })}
      >
        Resize location
      </button>
      <div ref={ref}>
        <Table
          className="table-fixed border-separate border-spacing-0 text-[0.8125rem]"
          style={{
            ...columnWidthVariables(
              table.getVisibleLeafColumns(),
              0,
              manual,
              measured,
            ),
            width: totalWidth + 400,
          }}
        >
          <TableHeader>
            <TableRow>
              {["quality", "location"].map((id) => (
                <TableHead
                  key={id}
                  data-column-id={id}
                  className="h-8 px-1 text-xs"
                  style={cellStyle(id)}
                >
                  {id === "quality" ? "Quality" : "Location"}
                </TableHead>
              ))}
              <TableHead style={{ width: 400 }} />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow data-cell-row="0">
              <TableCell
                data-column-id="quality"
                data-testid="quality"
                className={ROW_DENSITY.cellClass}
                style={cellStyle("quality")}
              >
                <CellFrame
                  trailing={
                    <button
                      type="button"
                      className={CELL_RAIL_BUTTON_CLASS}
                      aria-label="Explain quality"
                    >
                      i
                    </button>
                  }
                >
                  <Badge>Good</Badge>
                </CellFrame>
              </TableCell>
              <TableCell
                data-column-id="location"
                data-testid="location"
                className={ROW_DENSITY.cellClass}
                style={cellStyle("location")}
              >
                <button
                  data-cell-edit-trigger
                  className="inline-flex items-center gap-1"
                >
                  {icon && (
                    <span aria-hidden style={{ width: 32, flexShrink: 0 }}>
                      ◆
                    </span>
                  )}
                  <span>{location}</span>
                </button>
              </TableCell>
              <TableCell style={{ width: 400 }} />
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              {["quality", "location"].map((id) => (
                <TableCell key={id} data-column-id={id} style={cellStyle(id)}>
                  {id === "location" ? total : "Total"}
                </TableCell>
              ))}
              <TableCell style={{ width: 400 }} />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <output data-testid="manual-state">
        {JSON.stringify(table.state.columnSizing)}
      </output>
    </>
  );
}

const dateHelper = createCubbyColumnHelper<{ id: string; date: string }>();
const dateColumns = createCubbyColumnCollection<{ id: string; date: string }>(
  (add) => {
    add(
      createPlainDateColumn(dateHelper, "date", {
        header: "Date",
        editable: { onSave: async () => {} },
      }),
    );
  },
);

function DateFitFixture({ inherited = false }: { inherited?: boolean }) {
  const normalized = useTableColumnLayout({ columns: dateColumns });
  const table = useCubbyTable({
    data: [{ id: "synthetic", date: householdDaysFromNow(26) }],
    columns: normalized.columns,
    getRowId: (row) => row.id,
  });
  const ref = useRef<HTMLDivElement>(null);
  const measured = useRenderedColumnWidths(table, ref, "date", true);
  const column = table.getVisibleLeafColumns()[0];
  const cell = table.getRowModel().rows[0].getVisibleCells()[0];
  const fitted = measured.date ?? column.getSize();
  return (
    <div
      ref={ref}
      style={
        inherited
          ? { fontFamily: "monospace", fontWeight: 600, letterSpacing: "0.5px" }
          : undefined
      }
    >
      <Table
        className="table-fixed border-separate border-spacing-0 text-[0.8125rem] tabular-nums"
        style={{
          ...columnWidthVariables(
            table.getVisibleLeafColumns(),
            0,
            new Set(),
            measured,
          ),
          width: fitted + 400,
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead
              data-column-id="date"
              className="px-1 text-xs"
              style={{ width: columnWidthValue("date") }}
            >
              Date
            </TableHead>
            <TableHead style={{ width: 400 }} />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-cell-row="0">
            <TableCell
              data-column-id="date"
              data-testid="date"
              className={`${ROW_DENSITY.cellClass} overflow-hidden text-ellipsis`}
              style={{ width: columnWidthValue("date") }}
            >
              <div className={ROW_DENSITY.cellContentClass}>
                <div className="min-w-0">
                  {flexRender(column.columnDef.cell, cell.getContext())}
                </div>
              </div>
            </TableCell>
            <TableCell style={{ width: 400 }} />
          </TableRow>
        </TableBody>
      </Table>
      <output data-testid="date-fit">{measured.date ?? "pending"}</output>
    </div>
  );
}

const width = (element: Element) => element.getBoundingClientRect().width;

describe("rendered column fit", () => {
  it.each([false, true])(
    "keeps a future editable calendar label unclipped with inherited typography %s",
    async (inherited) => {
      await page.viewport(1440, 900);
      const view = render(<DateFitFixture inherited={inherited} />);
      await waitFor(() =>
        expect(view.getByTestId("date-fit").textContent).not.toBe("pending"),
      );
      const label = view.getByTestId("date").querySelector("[title]");
      if (!label) throw new Error("missing future calendar label");
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const clippingBounds: Array<{ left: number; right: number }> = [];
      for (let node: Element | null = label; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "hidden" || overflow === "clip") {
          const clip = node.getBoundingClientRect();
          const left = clip.left + node.clientLeft;
          clippingBounds.push({ left, right: left + node.clientWidth });
        }
        if (node.hasAttribute("data-column-id")) break;
      }
      expect(
        clippingBounds.every(
          (clip) => text.left >= clip.left - 1 && text.right <= clip.right + 1,
        ),
      ).toBe(true);
    },
  );

  it("counts visible icons within editable values", async () => {
    await page.viewport(1440, 900);
    const view = render(<FitFixture icon location="Workshop" />);
    await waitFor(() =>
      expect(width(view.getByTestId("location"))).toBeLessThan(184),
    );
    const value = view.getByTestId("location").querySelector("button");
    if (!value) throw new Error("missing editable value");
    expect(width(view.getByTestId("location"))).toBeGreaterThanOrEqual(
      value.scrollWidth + 8,
    );
  });

  it("fits aggregate footer totals larger than individual values", async () => {
    await page.viewport(1440, 900);
    const view = render(<FitFixture total="$123,456.78" />);
    await waitFor(() =>
      expect(width(view.getByTestId("location"))).toBeLessThan(184),
    );
    const total = view.getByText("$123,456.78");
    expect(total.clientWidth).toBeGreaterThanOrEqual(total.scrollWidth);
  });

  it("keeps fitted pinned headers, cells and footers adjacent", async () => {
    await page.viewport(1440, 900);
    const view = render(<FitFixture pinned />);
    await waitFor(() =>
      expect(width(view.getByTestId("quality"))).toBeLessThan(120),
    );
    for (const section of ["thead", "tbody", "tfoot"]) {
      const first = view.container.querySelector(
        `${section} [data-column-id=quality]`,
      );
      const second = view.container.querySelector(
        `${section} [data-column-id=location]`,
      );
      if (!first || !second) throw new Error("missing fitted pinned cells");
      expect(second.getBoundingClientRect().left).toBe(
        first.getBoundingClientRect().right,
      );
    }
  });

  it("fits short pills, links and rails without changing row density or manual state", async () => {
    await page.viewport(1440, 900);
    const view = render(<FitFixture />);
    await waitFor(() =>
      expect(width(view.getByTestId("quality"))).toBeLessThan(120),
    );
    expect(width(view.getByTestId("location"))).toBeLessThan(100);
    const pill = view.getByText("Good");
    const info = view.getByRole("button", { name: "Explain quality" });
    expect(
      info.getBoundingClientRect().left - pill.getBoundingClientRect().right,
    ).toBe(2);
    expect(view.getByTestId("quality").getBoundingClientRect().height).toBe(32);
    expect(view.getByTestId("manual-state").textContent).toBe("{}");
  });

  it("grows for enriched content up to the cap, never shrinks on hover, and honors manual sizing", async () => {
    await page.viewport(1440, 900);
    const view = render(<FitFixture />);
    await waitFor(() =>
      expect(width(view.getByTestId("location"))).toBeLessThan(100),
    );
    view.rerender(
      <FitFixture location="A much longer workshop location with several words" />,
    );
    await waitFor(() => expect(width(view.getByTestId("location"))).toBe(200));
    view.rerender(<FitFixture />);
    expect(width(view.getByTestId("location"))).toBe(200);
    fireEvent.mouseEnter(view.getByTestId("quality"));
    expect(width(view.getByTestId("location"))).toBe(200);
    fireEvent.click(view.getByRole("button", { name: "Resize location" }));
    await waitFor(() => expect(width(view.getByTestId("location"))).toBe(151));
    view.rerender(
      <FitFixture location="Longer still content should not replace the manual choice" />,
    );
    expect(width(view.getByTestId("location"))).toBe(151);
  });
});

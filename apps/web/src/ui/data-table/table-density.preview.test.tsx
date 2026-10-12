import { render, waitFor } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { householdDaysFromNow } from "~/lib/household-date";
import { CalendarDate } from "~/ui/common/calendar-date";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { MiddleTruncate } from "~/ui/common/middle-truncate";
import { HoverableTimestamp } from "~/ui/HoverableTimestamp";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

import { ROW_DENSITY } from "./density";
import { HeaderLabel } from "./TableHeaderLayout";
import { useCellSpill } from "./useCellSpill";

// Failure modes guarded here, all at a fixed 32px row:
// - a clipped value is unreadable without opening the record;
// - spill-over flashes for values that already fit, or outlives the hover;
// - a stacked date, chip cluster, or wrapped header stretches its row;
// - chips silently drop values instead of counting them;
// - a code truncates its distinguishing tail.

function Fixture({
  cells,
  header = "Value",
}: {
  cells: Array<{ id: string; width: number; content: ReactNode }>;
  header?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCellSpill(ref);
  return (
    <div ref={ref} style={{ width: 900 }}>
      <Table className="table-fixed border-separate border-spacing-0 text-[0.8125rem]">
        <TableHeader>
          <TableRow>
            {cells.map((cell, index) => (
              <TableHead
                key={cell.id}
                data-testid={`head-${index}`}
                className="px-1 text-xs"
                style={{ width: cell.width }}
              >
                <HeaderLabel label={header}>{header}</HeaderLabel>
              </TableHead>
            ))}
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-cell-row="0" className="table-record-row">
            {cells.map((cell, index) => (
              <TableCell
                key={cell.id}
                data-column-id={`c${index}`}
                data-testid={`cell-${index}`}
                className={ROW_DENSITY.cellClass}
                style={{ width: cell.width, maxWidth: cell.width }}
              >
                <div className={ROW_DENSITY.cellContentClass}>
                  <div className="min-w-0">{cell.content}</div>
                </div>
              </TableCell>
            ))}
            <TableCell />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

const overlay = () =>
  document.querySelector<HTMLElement>("[data-cell-spill-overlay]");
const rect = (element: Element) => element.getBoundingClientRect();

const LONG_NAME =
  "Synthetic Events · May 14, 2027 (planner retainer 4 of 4) with a long tail";

describe("table density", () => {
  it("spills a clipped value at row height and hides it when the pointer leaves", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        cells={[
          {
            id: "c1",
            width: 160,
            content: <span className="block truncate">{LONG_NAME}</span>,
          },
          {
            id: "c2",
            width: 160,
            content: <span className="block truncate">Short</span>,
          },
        ]}
      />,
    );
    const clipped = view.getByTestId("cell-0");
    await userEvent.hover(clipped);
    await waitFor(() => expect(overlay()?.textContent).toBe(LONG_NAME));
    const spill = overlay();
    if (!spill) throw new Error("missing spill overlay");
    expect(rect(spill).width).toBeGreaterThan(rect(clipped).width);
    expect(Math.round(rect(spill).height)).toBe(32);
    expect(Math.round(rect(spill).top)).toBe(Math.round(rect(clipped).top));
    expect(Math.round(rect(clipped).height)).toBe(32);

    await userEvent.hover(view.getByTestId("cell-1"));
    await waitFor(() => expect(overlay()).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(overlay()).toBeNull();
  });

  it("stacks dates and timestamps in two lines without stretching the row", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        cells={[
          {
            id: "c3",
            width: 96,
            content: <CalendarDate start={householdDaysFromNow(200)} stacked />,
          },
          {
            id: "c4",
            width: 72,
            content: (
              <HoverableTimestamp
                timestamp={new Date(Date.now() - 90 * 86_400_000)}
                stacked
              />
            ),
          },
        ]}
      />,
    );
    for (const id of ["cell-0", "cell-1"]) {
      const cell = view.getByTestId(id);
      const lines = cell.querySelectorAll("[data-stacked-line]");
      expect(lines).toHaveLength(2);
      const [first, second] = [...lines];
      if (!first || !second) throw new Error("missing stacked lines");
      expect(rect(second).top).toBeGreaterThanOrEqual(rect(first).bottom - 1);
      for (const line of lines) {
        expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
      }
      expect(Math.round(rect(cell).height)).toBe(32);
    }
    expect(view.getByTestId("cell-1").textContent).toMatch(/3mo ago$/);
  });

  it("wraps chips to two lines and counts what does not fit", async () => {
    await page.viewport(1440, 900);
    const names = [
      "Books & Media",
      "Groceries",
      "Health & Personal Care",
      "Kitchen",
      "Pets",
      "Software & Digital Services",
    ];
    const view = render(
      <Fixture
        cells={[
          {
            id: "c5",
            width: 180,
            content: (
              <ChipCluster
                items={names.map((name) => ({
                  key: name,
                  label: name,
                  node: <span>{name}</span>,
                }))}
              />
            ),
          },
        ]}
      />,
    );
    const cell = view.getByTestId("cell-0");
    await waitFor(() =>
      expect(cell.querySelector("[data-chip-overflow]")).not.toBeNull(),
    );
    const shown = [...cell.querySelectorAll<HTMLElement>("[data-chip]")].filter(
      (chip) => chip.offsetParent !== null,
    );
    const more = cell.querySelector("[data-chip-overflow]");
    expect(more?.textContent).toBe(`+${names.length - shown.length}`);
    const tops = new Set(shown.map((chip) => Math.round(rect(chip).top)));
    if (more) tops.add(Math.round(rect(more).top));
    expect(tops.size).toBeLessThanOrEqual(2);
    for (const chip of shown) {
      expect(rect(chip).bottom).toBeLessThanOrEqual(rect(cell).bottom);
      expect(rect(chip).right).toBeLessThanOrEqual(rect(cell).right);
    }
    expect(Math.round(rect(cell).height)).toBe(32);
  });

  it("keeps a code's distinguishing tail when it truncates", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        cells={[
          {
            id: "c6",
            width: 112,
            content: <MiddleTruncate text="113-2171451-2151435" />,
          },
        ]}
      />,
    );
    const tail = view.getByText("2151435");
    expect(tail.scrollWidth).toBeLessThanOrEqual(tail.clientWidth);
    expect(rect(tail).right).toBeLessThanOrEqual(
      rect(view.getByTestId("cell-0")).right,
    );
    await userEvent.hover(view.getByTestId("cell-0"));
    await waitFor(() =>
      expect(overlay()?.textContent).toBe("113-2171451-2151435"),
    );
  });

  it("wraps a long header to two lines inside a narrow column", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        header="Itemization coverage"
        cells={[{ id: "c7", width: 104, content: "" }]}
      />,
    );
    const label = view
      .getByTestId("head-0")
      .querySelector("[data-header-label]");
    if (!(label instanceof HTMLElement)) throw new Error("missing label");
    const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
    expect(Math.round(rect(label).height / lineHeight)).toBe(2);
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
  });
});

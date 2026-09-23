/**
 * Real-browser layout invariants for the shared table cell anatomy.
 *
 * Regression: a cell's affordances (ⓘ explanation, relation workbench,
 * suggestion mark) were bare flex siblings of a value that never clipped, so
 * a narrow money or date column painted its text under the icon ("$2.ⓘ99").
 * Editable cells also indented their value by the trigger's own padding and
 * reserved width for a hover-only pencil, so "—" sat at a different x in
 * every column. jsdom has no layout engine; these run in headless Chromium
 * via `pnpm test:preview`.
 */
import { render } from "@testing-library/react";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";

import { CellEditTrigger } from "./cell-edit-trigger";
import { CELL_RAIL_BUTTON_CLASS, CellFrame } from "./cell-frame";

const DESKTOP = { width: 1440, height: 900 } as const;
const CELL = "h-8 overflow-hidden text-ellipsis px-2 py-0 text-[0.8125rem]";

function Grid({ cells }: { cells: ReactNode[] }) {
  return (
    <Table className="table-fixed" style={{ width: cells.length * 104 }}>
      <TableBody>
        <TableRow>
          {cells.map((cell, index) => (
            <TableCell
              // oxlint-disable-next-line react/no-array-index-key -- static fixture columns
              key={index}
              data-testid={`cell-${index}`}
              className={CELL}
              style={{ width: 104 }}
            >
              {cell}
            </TableCell>
          ))}
        </TableRow>
      </TableBody>
    </Table>
  );
}

function rail() {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="How price is determined"
      className={CELL_RAIL_BUTTON_CLASS}
    >
      <Info className="size-3" />
    </Button>
  );
}

const rect = (element: Element | null) => {
  if (!element) throw new Error("missing element");
  return element.getBoundingClientRect();
};

describe("cell frame layout", () => {
  it("clips a long value with an ellipsis before its rail, never under it", async () => {
    await page.viewport(DESKTOP.width, DESKTOP.height);
    const { getByTestId } = render(
      <Grid
        cells={[
          <CellFrame key="a" trailing={rail()}>
            $1,234,567.89 per each
          </CellFrame>,
        ]}
      />,
    );
    const cell = getByTestId("cell-0");
    const value = cell.querySelector("[data-cell-value]");
    const button = cell.querySelector("button");
    expect(rect(value).right).toBeLessThanOrEqual(rect(button).left);
    expect(rect(button).right).toBeLessThanOrEqual(rect(cell).right);
    if (!(value instanceof HTMLElement)) throw new Error("missing value");
    expect(value.scrollWidth).toBeGreaterThan(value.clientWidth);
    expect(getComputedStyle(value).textOverflow).toBe("ellipsis");
  });

  it("starts plain, editable, and empty values on the same cell padding", async () => {
    await page.viewport(DESKTOP.width, DESKTOP.height);
    const { getByTestId } = render(
      <Grid
        cells={[
          <NoneValue key="plain" />,
          <CellEditTrigger key="wrap" onStartEdit={() => {}}>
            <NoneValue />
          </CellEditTrigger>,
          <CellFrame key="framed" trailing={rail()}>
            <NoneValue />
          </CellFrame>,
        ]}
      />,
    );
    const offsets = [0, 1, 2].map((index) => {
      const cell = getByTestId(`cell-${index}`);
      const dash = [...cell.querySelectorAll("span")].find(
        (span) => span.textContent === "—" && span.children.length === 0,
      );
      return Math.round(rect(dash ?? null).left - rect(cell).left);
    });
    expect(offsets).toEqual([8, 8, 8]);
  });

  it("keeps the hover pencil from taking width in a narrow editable cell", async () => {
    await page.viewport(DESKTOP.width, DESKTOP.height);
    const { getByTestId } = render(
      <Grid
        cells={[
          <CellEditTrigger key="wrap" onStartEdit={() => {}}>
            Sep 19, 2026 at noon
          </CellEditTrigger>,
        ]}
      />,
    );
    const cell = getByTestId("cell-0");
    const trigger = cell.querySelector("button");
    expect(rect(trigger).right).toBeLessThanOrEqual(rect(cell).right);
    const text = trigger?.querySelector("span.truncate");
    if (!(text instanceof HTMLElement)) throw new Error("missing value");
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
    // The pencil is absolutely positioned: it adds nothing to the flow width.
    const pencil = trigger?.querySelector("span[aria-hidden]");
    if (!(pencil instanceof HTMLElement)) throw new Error("missing pencil");
    expect(getComputedStyle(pencil).position).toBe("absolute");
  });
});

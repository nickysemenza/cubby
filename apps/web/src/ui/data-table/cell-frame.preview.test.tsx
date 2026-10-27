import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
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
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { ImageThumbnail } from "~/entity/table/image-thumbnail";
import { Button } from "~/ui/primitives/button";
import { NoneValue } from "~/ui/primitives/none-value";
import { Table, TableBody, TableCell, TableRow } from "~/ui/primitives/table";

import { CellEditTrigger } from "./cell-edit-trigger";
import { CELL_RAIL_BUTTON_CLASS, CellFrame } from "./cell-frame";
import { ROW_DENSITY } from "./density";

const DESKTOP = { width: 1440, height: 900 } as const;
const CELL = ROW_DENSITY.cellClass;

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
      <InfoIcon className="size-3" />
    </Button>
  );
}

const rect = (element: Element | null) => {
  if (!element) throw new Error("missing element");
  return element.getBoundingClientRect();
};

describe("cell frame layout", () => {
  it("makes the thumbnail frame exactly as tall as the data row", async () => {
    await page.viewport(DESKTOP.width, DESKTOP.height);
    const { getByTestId } = render(
      <Grid
        cells={[<ImageThumbnail key="image" images={[]} entity="product" />]}
      />,
    );
    const cell = getByTestId("cell-0");
    expect(rect(cell.querySelector(".thumbnail-ring")).height).toBe(
      rect(cell).height,
    );
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
    expect(offsets).toEqual([4, 4, 4]);
  });
});

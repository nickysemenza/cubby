import { render, waitFor } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ChipCluster } from "~/ui/common/chip-cluster";
import { MiddleTruncate } from "~/ui/common/middle-truncate";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

import { HeaderLabel } from "../../entity/table/table-header-layout";
import { CELL_RAIL_BUTTON_CLASS, CellFrame } from "./cell-frame";
import { ROW_DENSITY } from "./density";
import { RowActiveProvider } from "./row-activity";
import { useCellSpill } from "./use-cell-spill";

// At 32px row height, overflow must keep values and nested controls reachable.

function Fixture({
  cells,
  header = "Value",
  active = true,
}: {
  cells: Array<{
    id: string;
    width: number;
    content: ReactNode;
    numeric?: boolean;
  }>;
  header?: string;
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCellSpill(ref);
  return (
    <div ref={ref} style={{ width: 900 }}>
      <Table className="table-fixed border-separate border-spacing-0 text-sm">
        <TableHeader>
          <TableRow>
            {cells.map((cell, index) => (
              <TableHead
                key={cell.id}
                data-column-id={`c${index}`}
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
          <RowActiveProvider value={active}>
            <TableRow data-cell-row="0" className="table-record-row">
              {cells.map((cell, index) => (
                <TableCell
                  key={cell.id}
                  data-column-id={`c${index}`}
                  data-testid={`cell-${index}`}
                  className={`${ROW_DENSITY.cellClass}${cell.numeric ? " text-right" : ""}`}
                  style={{ width: cell.width, maxWidth: cell.width }}
                >
                  <div className={ROW_DENSITY.cellContentClass}>
                    <div className="min-w-0">{cell.content}</div>
                  </div>
                </TableCell>
              ))}
              <TableCell />
            </TableRow>
          </RowActiveProvider>
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

  it("overlays the explanation on the active row without reserving width", async () => {
    await page.viewport(1440, 900);
    const explain = (
      <button
        type="button"
        aria-label="Explain"
        className={CELL_RAIL_BUTTON_CLASS}
      >
        i
      </button>
    );
    const cells = [
      {
        id: "c9",
        width: 120,
        content: (
          <CellFrame overlay trailing={explain}>
            {LONG_NAME}
          </CellFrame>
        ),
      },
      {
        id: "c10",
        width: 64,
        numeric: true,
        content: (
          <CellFrame overlay trailing={explain}>
            12
          </CellFrame>
        ),
      },
    ];
    const idle = render(<Fixture active={false} cells={cells} />);
    expect(idle.queryAllByRole("button", { name: "Explain" })).toHaveLength(0);
    const idleWidths = [0, 1].map((index) => {
      const cell = idle.getByTestId(`cell-${index}`);
      const value = cell.querySelector("[data-cell-value]");
      const frame = cell.querySelector("[data-cell-frame]");
      if (!value || !frame) throw new Error("missing cell frame");
      expect(rect(value).width).toBe(rect(frame).width);
      return rect(value).width;
    });
    idle.unmount();

    const view = render(<Fixture cells={cells} />);
    const [text, number] = view.getAllByRole("button", { name: "Explain" });
    if (!text || !number) throw new Error("missing explanations");
    for (const index of [0, 1]) {
      const value = view
        .getByTestId(`cell-${index}`)
        .querySelector("[data-cell-value]");
      if (!value) throw new Error("missing value");
      expect(rect(value).width).toBe(idleWidths[index]);
    }
    const textFrame = view
      .getByTestId("cell-0")
      .querySelector("[data-cell-frame]");
    const numberFrame = view
      .getByTestId("cell-1")
      .querySelector("[data-cell-frame]");
    if (!textFrame || !numberFrame) throw new Error("missing frames");
    // Text ends under the ⓘ; a right-aligned number keeps its digits clear.
    expect(Math.round(rect(text).right)).toBe(
      Math.round(rect(textFrame).right),
    );
    expect(Math.round(rect(number).left)).toBe(
      Math.round(rect(numberFrame).left),
    );

    // The spill-over draws the ⓘ after the full text and forwards clicks.
    await userEvent.hover(view.getByTestId("cell-0"));
    await waitFor(() => expect(overlay()).not.toBeNull());
    const spill = overlay();
    const rail = spill?.querySelector("[data-cell-spill-rail]");
    const textSpan = spill?.querySelector("[data-cell-value]");
    if (!spill || !rail || !textSpan)
      throw new Error("spill hid the explanation");
    const range = document.createRange();
    range.selectNodeContents(textSpan);
    expect(range.getBoundingClientRect().right).toBeLessThanOrEqual(
      rect(rail).left,
    );
    expect(rect(rail).right).toBeLessThanOrEqual(rect(spill).right);
  });

  it("spills a value the ⓘ covers even when it exactly fits", async () => {
    await page.viewport(1440, 900);
    const clicks: string[] = [];
    const view = render(
      <Fixture
        cells={[
          {
            id: "c11",
            width: 64,
            content: (
              <CellFrame
                overlay
                trailing={
                  <button
                    type="button"
                    aria-label="Explain"
                    className={CELL_RAIL_BUTTON_CLASS}
                    onClick={() => clicks.push("explain")}
                  >
                    i
                  </button>
                }
              >
                <span style={{ display: "inline-block", width: 56 }}>
                  Fitted
                </span>
              </CellFrame>
            ),
          },
        ]}
      />,
    );
    await userEvent.hover(view.getByTestId("cell-0"));
    await waitFor(() => expect(overlay()).not.toBeNull());
    const copy = overlay()?.querySelector<HTMLElement>(
      "[data-cell-spill-rail] button",
    );
    if (!copy) throw new Error("missing explanation copy");
    copy.click();
    expect(clicks).toEqual(["explain"]);
  });

  it("puts nested rails side by side", async () => {
    await page.viewport(1440, 900);
    const button = (label: string) => (
      <button
        type="button"
        aria-label={label}
        className={CELL_RAIL_BUTTON_CLASS}
      >
        i
      </button>
    );
    const view = render(
      <Fixture
        cells={[
          {
            id: "c12",
            width: 96,
            numeric: true,
            content: (
              <CellFrame overlay trailing={button("Explain")}>
                <CellFrame overlay trailing={button("Open related")}>
                  3
                </CellFrame>
              </CellFrame>
            ),
          },
        ]}
      />,
    );
    for (const label of ["Explain", "Open related"]) {
      const target = view.getByRole("button", { name: label });
      const box = rect(target);
      expect(
        document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ),
      ).toBe(target);
    }
  });

  it("keeps the ⓘ when a value inside an in-flow frame spills", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        cells={[
          {
            id: "c13",
            width: 120,
            content: (
              <CellFrame
                overlay
                trailing={
                  <button
                    type="button"
                    aria-label="Explain"
                    className={CELL_RAIL_BUTTON_CLASS}
                  >
                    i
                  </button>
                }
              >
                <CellFrame trailing={<span aria-label="Suggested" />}>
                  <span className="block truncate">{LONG_NAME}</span>
                </CellFrame>
              </CellFrame>
            ),
          },
        ]}
      />,
    );
    await userEvent.hover(view.getByTestId("cell-0"));
    await waitFor(() => expect(overlay()?.textContent).toContain(LONG_NAME));
    expect(
      overlay()?.querySelector("[data-cell-spill-rail] [aria-label='Explain']"),
    ).not.toBeNull();
  });

  it("never paints the ⓘ over clipped text; the spill carries it", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        cells={[
          {
            id: "c13b",
            width: 120,
            content: (
              <CellFrame
                overlay
                trailing={
                  <button
                    type="button"
                    aria-label="Explain"
                    className={CELL_RAIL_BUTTON_CLASS}
                  >
                    i
                  </button>
                }
              >
                {LONG_NAME}
              </CellFrame>
            ),
          },
        ]}
      />,
    );
    const rail = view
      .getByTestId("cell-0")
      .querySelector<HTMLElement>("[data-cell-rail]");
    if (!rail) throw new Error("missing rail");
    await waitFor(() => expect(rail).toHaveAttribute("data-rail-covers"));
    expect(getComputedStyle(rail).opacity).toBe("0");
    expect(getComputedStyle(rail).pointerEvents).toBe("none");
    await userEvent.hover(view.getByTestId("cell-0"));
    await waitFor(() => expect(overlay()?.textContent).toContain(LONG_NAME));
    const copy = overlay()?.querySelector<HTMLElement>(
      "[data-cell-spill-rail]",
    );
    expect(copy && getComputedStyle(copy).opacity).toBe("1");
  });

  // Regression: 20px pills wrapped to a second line the 32px cell clipped
  // through the middle; only 12px chips fit two lines.
  it("never wraps pill-height chips to a clipped second line", async () => {
    await page.viewport(1440, 900);
    const labels = ["Restores a link", "Clears a gap", "Needs a look"];
    const view = render(
      <Fixture
        cells={[
          {
            id: "c5b",
            width: 140,
            content: (
              <ChipCluster
                items={labels.map((label) => ({
                  key: label,
                  label,
                  node: (
                    <span style={{ display: "block", height: 20 }}>
                      {label}
                    </span>
                  ),
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
    const shown = [...cell.querySelectorAll<HTMLElement>("[data-chip]")];
    const tops = new Set(shown.map((chip) => Math.round(rect(chip).top)));
    expect(tops.size).toBe(1);
    expect(Math.round(rect(cell).height)).toBe(32);
  });

  it("keeps a code's first and last four characters when it truncates", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        cells={[
          {
            id: "c6",
            width: 88,
            content: (
              <MiddleTruncate
                code
                text="113-2171451-2151435"
                className="font-mono"
              />
            ),
          },
        ]}
      />,
    );
    const cell = view.getByTestId("cell-0");
    for (const end of ["113-", "…", "1435"]) {
      const part = view.getByText(end, { exact: true });
      expect(part.scrollWidth).toBeLessThanOrEqual(part.clientWidth);
      expect(rect(part).width).toBeGreaterThan(0);
      expect(rect(part).right).toBeLessThanOrEqual(rect(cell).right);
    }
    await userEvent.hover(cell);
    await waitFor(() =>
      expect(overlay()?.textContent).toBe("113-2171451-2151435"),
    );
  });

  it("spills a name clamped to two lines and a truncated header", async () => {
    await page.viewport(1440, 900);
    const header = "Synthetic itemization coverage across purchases";
    const view = render(
      <Fixture
        header={header}
        cells={[
          {
            id: "c14",
            width: 72,
            content: (
              <span
                data-stacked-line=""
                className="line-clamp-2 leading-[14px] break-words whitespace-normal"
              >
                {LONG_NAME}
              </span>
            ),
          },
        ]}
      />,
    );
    await userEvent.hover(view.getByTestId("cell-0"));
    await waitFor(() => expect(overlay()?.textContent).toBe(LONG_NAME));
    await userEvent.hover(view.getByTestId("head-0"));
    await waitFor(() => expect(overlay()?.textContent).toBe(header));
  });

  it("lets a copied rail glyph pass clicks through", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        cells={[
          {
            id: "c15",
            width: 96,
            content: (
              <CellFrame overlay trailing={<span data-testid="glyph">↕</span>}>
                <span className="block truncate">{LONG_NAME}</span>
              </CellFrame>
            ),
          },
        ]}
      />,
    );
    await userEvent.hover(view.getByTestId("cell-0"));
    await waitFor(() => expect(overlay()).not.toBeNull());
    const glyph = overlay()?.querySelector<HTMLElement>(
      "[data-cell-spill-rail] [data-testid='glyph']",
    );
    if (!glyph) throw new Error("missing rail copy");
    expect(getComputedStyle(glyph).pointerEvents).toBe("none");
  });

  it("does not spill a fitting value for its screen-reader text", async () => {
    await page.viewport(1440, 900);
    const view = render(
      <Fixture
        cells={[
          {
            id: "c16",
            width: 200,
            content: (
              <span className="flex flex-col">
                <span
                  data-stacked-line=""
                  className="block truncate leading-[15px]"
                >
                  Shelf
                </span>
                <span
                  data-stacked-line=""
                  className="block truncate text-xs leading-[13px]"
                >
                  <span className="sr-only"> · </span>1 each
                </span>
              </span>
            ),
          },
        ]}
      />,
    );
    await userEvent.hover(view.getByTestId("cell-0"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(overlay()).toBeNull();
  });

  it.each([1, 4])(
    "keeps the first named chip when %i tall chips overflow",
    async (count) => {
      await page.viewport(1440, 900);
      const chip = (label: string) => ({
        key: label,
        label,
        node: (
          <span
            className="min-w-0 truncate"
            style={{ display: "block", height: 32 }}
          >
            {label}
          </span>
        ),
      });
      const view = render(
        <Fixture
          cells={[
            {
              id: "c17",
              width: 64,
              content: (
                <ChipCluster
                  items={["Household equipment", "beta", "gamma", "delta"]
                    .slice(0, count)
                    .map(chip)}
                />
              ),
            },
          ]}
        />,
      );
      const cluster = view
        .getByTestId("cell-0")
        .querySelector<HTMLElement>("[data-cell-wrap]");
      if (!cluster) throw new Error("missing cluster");
      await waitFor(() =>
        expect(cluster.scrollHeight).toBeLessThanOrEqual(cluster.clientHeight),
      );
      const first = cluster.querySelector<HTMLElement>("[data-chip]");
      if (!first) throw new Error("missing named chip");
      expect(first.textContent).toBe("Household equipment");
      expect(rect(first).width).toBeGreaterThan(0);
      expect(rect(first).bottom).toBeLessThanOrEqual(rect(cluster).bottom);
      expect(rect(first).right).toBeLessThanOrEqual(rect(cluster).right);
      const overflow = cluster.querySelector("[data-chip-overflow]");
      expect(overflow?.textContent ?? null).toBe(
        count === 1 ? null : `+${count - 1}`,
      );
      expect(Math.round(rect(view.getByTestId("cell-0")).height)).toBe(32);
    },
  );
});

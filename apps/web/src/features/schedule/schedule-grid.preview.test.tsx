import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import {
  ScheduleGrid,
  scheduleDayIndex,
  type ScheduleRow,
  type ScheduleWindow,
} from "./schedule-grid";

const rows: ScheduleRow[] = [
  {
    id: "dated",
    name: "A long schedule label that must stay beside its time grid",
    depth: 0,
    segments: [
      {
        id: "dated-range",
        label: "Active",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        variant: "range",
      },
    ],
  },
  {
    id: "undated",
    name: "Undated work",
    depth: 0,
    segments: [],
  },
];

function Fixture({
  scheduleRows = rows,
  window = { startDate: "2026-01-01", endDate: "2026-12-31" },
}: {
  scheduleRows?: ScheduleRow[];
  window?: ScheduleWindow;
}) {
  return (
    <div style={{ width: "min(100%, 900px)" }}>
      <ScheduleGrid
        rows={scheduleRows}
        window={window}
        ariaLabel="Preview schedule"
      />
    </div>
  );
}

describe("schedule layout", () => {
  it("uses 32px ruled desktop rows and keeps labels pinned while the dates scroll", async () => {
    await page.viewport(1440, 900);
    const { getByRole } = render(<Fixture />);
    const grid = getByRole("grid", { name: "Preview schedule" });
    const row = getByRole("row", { name: "Undated work, No date" });
    const label = row.querySelector('[role="rowheader"]');
    if (!(grid instanceof HTMLElement) || !label)
      throw new Error("Missing grid");
    expect(Math.round(row.getBoundingClientRect().height)).toBe(32);
    const before = label.getBoundingClientRect().left;
    grid.scrollLeft = 200;
    expect(Math.round(label.getBoundingClientRect().left)).toBe(
      Math.round(before),
    );
  });

  it("shows a readable list on phones without widening the page", async () => {
    await page.viewport(402, 874);
    const phoneRows = [
      rows[0]!,
      {
        ...rows[1]!,
        meta: "planned · Planned window: after the autumn harvest is complete",
        metaShort: "planned",
      },
    ];
    const { getByRole } = render(<Fixture scheduleRows={phoneRows} />);
    const item = getByRole("list", {
      name: "Preview schedule",
    }).querySelectorAll("li")[1];
    if (!item) throw new Error("Missing mobile schedule row");
    expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(item.textContent).toContain("after the autumn harvest is complete");
    expect(getComputedStyle(item.querySelector(".text-xs")!).whiteSpace).toBe(
      "normal",
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(402);
  });

  it("keeps the date header pinned over a dense desktop schedule", async () => {
    await page.viewport(1440, 900);
    const denseRows = Array.from({ length: 60 }, (_, index) => ({
      ...rows[0]!,
      id: `dense-${index}`,
      name: `Activity ${index}`,
    }));
    const { getByRole } = render(<Fixture scheduleRows={denseRows} />);
    const grid = getByRole("grid", { name: "Preview schedule" });
    const header = grid.querySelector('[role="columnheader"]');
    if (!(grid instanceof HTMLElement) || !header)
      throw new Error("Missing schedule header");
    const before = header.getBoundingClientRect().top;
    grid.scrollTop = 300;
    expect(Math.round(header.getBoundingClientRect().top)).toBe(
      Math.round(before),
    );
  });

  it("arrives near today in a long project window and preserves the date on scale changes", async () => {
    await page.viewport(1440, 900);
    const longWindow = { startDate: "2015-01-01", endDate: "2028-12-31" };
    const { getByRole, getByTestId, rerender } = render(
      <Fixture window={longWindow} />,
    );
    const grid = getByRole("grid", { name: "Preview schedule" });
    const todayLine = getByTestId("schedule-today-line");
    if (!(grid instanceof HTMLElement))
      throw new Error("Missing schedule grid");
    const label = grid.querySelector('[role="rowheader"]');
    if (!label) throw new Error("Missing row label");
    const dateArea = grid.clientWidth - label.getBoundingClientRect().width;
    const center = label.getBoundingClientRect().right + dateArea / 2;
    expect(
      Math.abs(todayLine.getBoundingClientRect().left - center),
    ).toBeLessThan(8);
    const start = scheduleDayIndex(longWindow.startDate)!;
    const monthCenter = start + (grid.scrollLeft + dateArea / 2) / 4;
    fireEvent.click(getByRole("button", { name: "week" }));
    const weekCenter = start + (grid.scrollLeft + dateArea / 2) / 12;
    expect(Math.abs(weekCenter - monthCenter)).toBeLessThan(2);

    grid.scrollLeft += 330;
    const manualPosition = grid.scrollLeft;
    rerender(
      <Fixture
        window={longWindow}
        scheduleRows={[...rows, { ...rows[1]!, id: "loaded" }]}
      />,
    );
    expect(grid.scrollLeft).toBe(manualPosition);
    fireEvent.click(getByRole("button", { name: "Today" }));
    expect(
      Math.abs(todayLine.getBoundingClientRect().left - center),
    ).toBeLessThan(8);

    rerender(
      <Fixture window={{ startDate: "2024-01-01", endDate: "2024-12-31" }} />,
    );
    expect(grid.scrollLeft).toBe(0);
  });

  it("keeps milestone marks behind pinned names and range text on one line", async () => {
    await page.viewport(1440, 900);
    const overlapRows: ScheduleRow[] = [
      {
        id: "overlap",
        name: "A deliberately long planting name with a missing cover",
        depth: 0,
        meta: "growing · Planned window: late spring in a raised bed",
        metaShort: "growing",
        segments: [
          {
            id: "mark",
            label: "Sown",
            startDate: "2026-01-10",
            variant: "milestone",
          },
          {
            id: "bar",
            label: "An exceptionally long expected harvest description",
            startDate: "2026-03-01",
            endDate: "2026-04-30",
            variant: "range",
          },
        ],
      },
    ];
    const { getByRole } = render(<Fixture scheduleRows={overlapRows} />);
    const grid = getByRole("grid", { name: "Preview schedule" });
    const row = getByRole("row", { name: /A deliberately long planting name/ });
    const label = row.querySelector('[role="rowheader"]');
    const mark = getByRole("img", { name: /Sown, Jan 10/ });
    const bar = getByRole("img", {
      name: /An exceptionally long expected harvest description/,
    });
    if (!(grid instanceof HTMLElement) || !label)
      throw new Error("Missing schedule row");
    grid.scrollLeft = 100;
    const bounds = mark.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    expect(label.contains(hit)).toBe(true);
    expect(getComputedStyle(bar).whiteSpace).toBe("nowrap");
    expect(Math.round(row.getBoundingClientRect().height)).toBe(32);
    expect(
      label.querySelector(
        '[title="growing · Planned window: late spring in a raised bed"]',
      ),
    ).not.toBeNull();
  });
});

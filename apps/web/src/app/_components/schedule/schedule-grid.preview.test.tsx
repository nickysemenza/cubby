import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { ScheduleGrid, type ScheduleRow } from "./schedule-grid";

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

function Fixture({ scheduleRows = rows }: { scheduleRows?: ScheduleRow[] }) {
  return (
    <div style={{ width: "min(100%, 900px)" }}>
      <ScheduleGrid
        rows={scheduleRows}
        window={{ startDate: "2026-01-01", endDate: "2026-12-31" }}
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
    const { getByRole } = render(<Fixture />);
    const item = getByRole("list", {
      name: "Preview schedule",
    }).querySelectorAll("li")[1];
    if (!item) throw new Error("Missing mobile schedule row");
    expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
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
});

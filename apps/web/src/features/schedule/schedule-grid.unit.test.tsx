import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ScheduleGrid,
  scheduleDayIndex,
  scheduleScrollLeft,
  type ScheduleRow,
} from "./schedule-grid";

const rows: ScheduleRow[] = [
  {
    id: "group",
    name: "Garden",
    depth: 0,
    group: true,
    expandable: true,
    expanded: true,
    segments: [],
  },
  {
    id: "dated",
    name: "Sow peas",
    depth: 1,
    segments: [
      {
        id: "sow",
        label: "Sown",
        startDate: "2026-03-08",
        variant: "milestone",
      },
      {
        id: "grow",
        label: "Growing",
        startDate: "2026-03-08",
        endDate: "2026-03-10",
        variant: "range",
      },
    ],
  },
  {
    id: "undated",
    name: "Plant later",
    depth: 1,
    segments: [],
    noDateLabel: "No planting date",
  },
];

describe("ScheduleGrid", () => {
  it("keeps household date boundaries stable across daylight-saving changes", () => {
    expect(
      scheduleDayIndex("2026-03-10")! - scheduleDayIndex("2026-03-08")!,
    ).toBe(2);
    expect(scheduleDayIndex("2026-02-30")).toBeNull();
  });

  it("centers the focus day in the date area and clamps at window edges", () => {
    const start = scheduleDayIndex("2015-01-01")!;
    const today = scheduleDayIndex("2026-09-23")!;
    const left = scheduleScrollLeft(today, start, 4, 900, 20_000);
    expect(left).toBeCloseTo((today - start + 0.5) * 4 - (900 - 368) / 2);
    expect(scheduleScrollLeft(start, start, 4, 900, 20_000)).toBe(0);
    expect(scheduleScrollLeft(start + 100, start, 4, 900, 640)).toBe(108);
  });

  it("keeps an undated lane and renders multiple milestones on one row", () => {
    render(
      <ScheduleGrid
        rows={rows}
        window={{ startDate: "2026-03-08", endDate: "2026-03-10" }}
        ariaLabel="Garden schedule"
      />,
    );

    expect(
      screen.getByRole("grid", { name: "Garden schedule" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Sown, Mar 8/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Growing, Mar 8 to Mar 10/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("row", { name: /Plant later, No planting date/ }),
    ).toBeInTheDocument();
  });

  it("moves between rows and expands a hierarchy with the keyboard", () => {
    const onToggle = vi.fn();
    const onRowActivate = vi.fn();
    render(
      <ScheduleGrid
        rows={rows}
        window={{ startDate: "2026-03-08", endDate: "2026-03-10" }}
        ariaLabel="Garden schedule"
        onToggle={onToggle}
        onRowActivate={onRowActivate}
      />,
    );

    const group = screen.getByRole("row", { name: "Garden" });
    group.focus();
    fireEvent.keyDown(group, { key: "ArrowDown" });
    const dated = screen.getByRole("row", { name: "Sow peas" });
    expect(dated).toHaveFocus();
    fireEvent.keyDown(dated, { key: "Enter" });
    expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(onToggle).toHaveBeenCalledWith("group");
  });
});

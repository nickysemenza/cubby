import { plantingOut } from "@cubby/schemas/planting";
import { taskOut } from "@cubby/schemas/project";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScheduleGrid } from "~/app/_components/schedule/schedule-grid";
import { mock } from "~/lib/test/mock-schema";

import { calendarScheduleRows } from "./calendar-schedule";

describe("calendarScheduleRows", () => {
  it("keeps each planting on one row with all milestones and leaves undated records visible", () => {
    const rows = calendarScheduleRows({
      tasks: [
        mock(taskOut, {
          overrides: {
            name: "Prepare bed",
            dueDate: "2026-04-01",
            dueEndDate: "2026-04-04",
          },
        }),
        mock(taskOut, {
          overrides: {
            name: "Check supplies",
            dueDate: null,
            dueEndDate: null,
          },
        }),
      ],
      plantings: [
        mock(plantingOut, {
          overrides: {
            displayName: "Example crop",
            sowedOn: "2026-04-02",
            transplantedOn: "2026-05-10",
            finishedOn: null,
          },
        }),
        mock(plantingOut, {
          overrides: {
            displayName: "Undated crop",
            sowedOn: null,
            transplantedOn: null,
            finishedOn: null,
          },
        }),
      ],
    });

    expect(rows.filter((row) => row.group).map((row) => row.name)).toEqual([
      "Tasks",
      "Plantings",
    ]);
    expect(rows.find((row) => row.name === "Prepare bed")?.segments).toEqual([
      expect.objectContaining({
        startDate: "2026-04-01",
        endDate: "2026-04-04",
        variant: "range",
      }),
    ]);
    expect(rows.find((row) => row.name === "Example crop")?.segments).toEqual([
      expect.objectContaining({ label: "Sowed", startDate: "2026-04-02" }),
      expect.objectContaining({
        label: "Transplanted",
        startDate: "2026-05-10",
      }),
    ]);
    expect(rows.find((row) => row.name === "Check supplies")).toMatchObject({
      segments: [],
      noDateLabel: "No due date",
    });
    expect(rows.find((row) => row.name === "Undated crop")).toMatchObject({
      segments: [],
      noDateLabel: "No milestone date",
    });
  });

  it("renders dated and undated lanes in the shared schedule grid", () => {
    const rows = calendarScheduleRows({
      tasks: [
        mock(taskOut, {
          overrides: {
            name: "Prepare bed",
            dueDate: null,
            dueEndDate: null,
          },
        }),
      ],
      plantings: [
        mock(plantingOut, {
          overrides: {
            displayName: "Example crop",
            sowedOn: "2026-04-02",
            transplantedOn: "2026-04-10",
            finishedOn: null,
          },
        }),
      ],
    });
    render(
      <ScheduleGrid
        rows={rows}
        window={{ startDate: "2026-04-01", endDate: "2026-04-30" }}
        ariaLabel="Garden schedule"
      />,
    );

    const grid = screen.getByRole("grid", { name: "Garden schedule" });
    expect(
      within(grid).getByRole("row", { name: /Prepare bed.*No due date/ }),
    ).toBeInTheDocument();
    expect(
      within(grid).getByRole("img", { name: /Sowed, Apr 2/ }),
    ).toBeInTheDocument();
    expect(
      within(grid).getByRole("img", { name: /Transplanted, Apr 10/ }),
    ).toBeInTheDocument();
  });
});

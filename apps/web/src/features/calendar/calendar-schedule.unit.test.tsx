import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScheduleGrid } from "~/features/schedule/schedule-grid";
import { mock } from "~/lib/test/mock-schema";

import { calendarScheduleRows } from "./calendar-schedule";
const plantingOut = entityFieldEnvelopeSchemas.planting.detail;
const taskOut = entityFieldEnvelopeSchemas.task.detail;

describe("calendarScheduleRows", () => {
  it("keeps each planting on one row with all milestones and leaves undated records visible", () => {
    const rows = calendarScheduleRows({
      tasks: [
        mock(taskOut, {
          overrides: {
            name: "Prepare bed",
            due: { start: "2026-04-01", end: "2026-04-04" },
          },
        }),
        mock(taskOut, {
          overrides: {
            name: "Check supplies",
            due: null,
          },
        }),
      ],
      plantings: [
        mock(plantingOut, {
          overrides: {
            displayName: "Example crop",
            season: { start: "2026-04-02", end: null },
            transplantedOn: "2026-05-10",
          },
        }),
        mock(plantingOut, {
          overrides: {
            displayName: "Undated crop",
            season: null,
            transplantedOn: null,
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
            due: null,
          },
        }),
      ],
      plantings: [
        mock(plantingOut, {
          overrides: {
            displayName: "Example crop",
            season: { start: "2026-04-02", end: null },
            transplantedOn: "2026-04-10",
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

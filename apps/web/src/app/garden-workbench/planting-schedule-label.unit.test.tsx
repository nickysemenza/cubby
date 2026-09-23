import { plantingGuides } from "@cubby/schemas/garden-guides";
import { imageShortcode } from "@cubby/schemas/identifiers";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ScheduleGrid,
  type ScheduleRow,
} from "~/app/_components/schedule/schedule-grid";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { usePlantingScheduleLabel } from "./planting-schedule-label";

const source = plantingGuides.sources[0]!;
const rows: ScheduleRow[] = [
  { id: "planting:PLT-TEST", name: "Test carrot", depth: 1, segments: [] },
  { id: "planting:PLT-NO-COVER", name: "Test pea", depth: 1, segments: [] },
  {
    id: `guide:carrot:${source.id}:0`,
    name: source.name,
    depth: 1,
    segments: [],
  },
  {
    id: "location:unplaced",
    name: "No current location",
    depth: 0,
    group: true,
    segments: [],
  },
];

function Fixture() {
  const renderLabel = usePlantingScheduleLabel(rows, [
    {
      id: "PLT-TEST",
      displayImages: [
        {
          id: imageShortcode.parse("IMG-TEST"),
          url: "https://example.com/seed.jpg",
        },
      ],
    },
    { id: "PLT-NO-COVER", displayImages: [] },
  ]);
  return (
    <ScheduleGrid
      rows={rows}
      window={{ startDate: "2026-01-01", endDate: "2026-12-31" }}
      ariaLabel="Test planting schedule"
      renderLabel={renderLabel}
    />
  );
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("planting schedule labels", () => {
  it("links records with their cover or mark, cites guides, and leaves the unplaced group plain", () => {
    render(<Fixture />, { wrapper: harness.wrapper });
    const grid = screen.getByRole("grid", { name: "Test planting schedule" });
    const planting = within(grid).getByRole("row", { name: /Test carrot/ });
    const plantingLink = within(planting).getByRole("link", {
      name: "Test carrot",
    });
    expect(plantingLink).toHaveAttribute("href", "/plantings/PLT-TEST");
    expect(plantingLink.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/seed.jpg",
    );

    const noCover = within(grid).getByRole("row", { name: /Test pea/ });
    const noCoverLink = within(noCover).getByRole("link", {
      name: "Test pea",
    });
    expect(noCoverLink).toHaveAttribute("href", "/plantings/PLT-NO-COVER");
    expect(noCoverLink.querySelector("svg")).not.toBeNull();

    const guide = within(grid).getByRole("row", {
      name: `${source.name}, No date`,
    });
    expect(
      within(guide).getByRole("link", { name: source.name }),
    ).toHaveAttribute("href", source.url);
    const unplaced = within(grid).getByRole("row", {
      name: "No current location",
    });
    expect(within(unplaced).queryByRole("link")).toBeNull();
  });
});

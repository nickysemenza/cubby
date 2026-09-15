import { gardenEntryOut, type GardenEntryOut } from "@cubby/schemas/garden";
import { testShortcode } from "@cubby/schemas/testing";
import type { UseQueryResult } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { GardenTimelineContent } from "./garden-timeline";

function buildEntry(
  overrides: Partial<Parameters<typeof gardenEntryOut.parse>[0]> = {},
): GardenEntryOut {
  return gardenEntryOut.parse({
    id: testShortcode("gardenEntry", "GDE-4K7M"),
    locationId: testShortcode("location", "LOC-4K7M"),
    locationName: "Test bed",
    plantingId: testShortcode("planting", "PLT-4K7M"),
    plantingName: "Test tomato",
    kind: "observation",
    observedOn: "2026-09-01",
    note: null,
    harvestAmount: null,
    images: [],
    anchorsPeriod: false,
    displayName: "Note · 2026-09-01 · Test bed",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

/** `GardenTimelineContent` takes its query result as a plain prop, so a fake
 * `UseQueryResult` sidesteps mocking the `garden.journal`/`garden.entries`
 * network transport entirely. */
function fakeEntries(
  items: GardenEntryOut[],
  hasMore = false,
): UseQueryResult<{ items: GardenEntryOut[]; hasMore: boolean }> {
  // SAFETY: `GardenTimelineContent` only reads `isPending`/`isError`/`data`/
  // `refetch` from its query-result prop; the rest of `UseQueryResult`'s
  // fields are irrelevant to this fixture, so this fake is intentionally
  // partial.
  return {
    isPending: false,
    isError: false,
    data: { items, hasMore },
    refetch: () => Promise.resolve(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("Journal entry kind wording", () => {
  it("reads Note/Harvest/Move, never Observation, with a whole-area prefix off-planting", async () => {
    const harness = createBrowserTestHarness();
    try {
      const note = buildEntry({ kind: "observation" });
      const harvest = buildEntry({
        id: testShortcode("gardenEntry", "GDE-4K7N"),
        kind: "harvest",
        harvestAmount: "3 lbs",
      });
      const wholeAreaMove = buildEntry({
        id: testShortcode("gardenEntry", "GDE-4K7P"),
        kind: "move",
        plantingId: null,
        plantingName: null,
      });
      render(
        <GardenTimelineContent
          entries={fakeEntries([note, harvest, wholeAreaMove])}
          page={1}
          setPage={() => {}}
        />,
        { wrapper: harness.wrapper },
      );
      expect(
        await screen.findByRole("link", { name: /· Note$/ }),
      ).toBeVisible();
      expect(screen.getByRole("link", { name: /· Harvest$/ })).toBeVisible();
      expect(screen.getByText("Harvest: 3 lbs")).toBeVisible();
      expect(
        screen.getByRole("link", { name: /Whole area · Move$/ }),
      ).toBeVisible();
      expect(screen.queryByText(/Observation/)).toBeNull();
    } finally {
      harness.dispose();
    }
  });
});

describe("Journal pager", () => {
  it("is hidden when the whole journal fits on one page", async () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <GardenTimelineContent
          entries={fakeEntries([buildEntry()], false)}
          page={1}
          setPage={() => {}}
        />,
        { wrapper: harness.wrapper },
      );
      await screen.findByRole("link", { name: /· Note$/ });
      expect(
        screen.queryByRole("button", { name: "Newer entries" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Older entries" }),
      ).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("is shown once there is a second page", async () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <GardenTimelineContent
          entries={fakeEntries([buildEntry()], true)}
          page={1}
          setPage={() => {}}
        />,
        { wrapper: harness.wrapper },
      );
      expect(
        await screen.findByRole("button", { name: "Newer entries" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Older entries" }),
      ).toBeEnabled();
    } finally {
      harness.dispose();
    }
  });
});

describe("Anchor entries", () => {
  it("get a Started here chip and an Edit note button explaining the lock", async () => {
    const harness = createBrowserTestHarness();
    try {
      const anchor = buildEntry({ anchorsPeriod: true });
      const ordinary = buildEntry({
        id: testShortcode("gardenEntry", "GDE-4K7Q"),
        anchorsPeriod: false,
      });
      render(
        <GardenTimelineContent
          entries={fakeEntries([anchor, ordinary])}
          page={1}
          setPage={() => {}}
        />,
        { wrapper: harness.wrapper },
      );
      expect(await screen.findByText("Started here")).toBeVisible();
      const editNote = screen.getByRole("button", { name: "Edit note" });
      expect(editNote.title).toContain("Location history");
      expect(screen.getByRole("button", { name: "Edit entry" })).toBeVisible();
    } finally {
      harness.dispose();
    }
  });
});

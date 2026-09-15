import {
  gardenEntriesOut,
  gardenOverviewOut,
  gardenPlantingOut,
} from "@cubby/schemas/garden";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { locationGardenSections } from "./garden-seam-sections";
import { garden } from "./garden.functions";

const LOCATION_ID = testShortcode("location", "LOC-BED1");

const PLANTING = gardenPlantingOut.parse({
  id: testShortcode("planting", "PLT-TOM1"),
  ingredientId: testShortcode("ingredient", "ING-TOM1"),
  sourceProductId: null,
  locationId: LOCATION_ID,
  intendedLocationId: null,
  parentPlantingId: null,
  status: "growing",
  variety: "Roma",
  quantity: "6 plants",
  notes: null,
  plannedWindow: null,
  plannedDate: null,
  sowedOn: "2026-03-01",
  transplantedOn: null,
  finishedOn: null,
  displayName: "Tomato · Roma",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ingredientName: "Tomato",
  gardenGuideKey: "tomato",
  sourceProductName: null,
  locationName: "Raised bed 1",
  intendedLocationName: null,
});

const OVERVIEW = gardenOverviewOut.parse({
  locations: [
    {
      id: LOCATION_ID,
      name: "Raised bed 1",
      gardenKind: "bed",
      gardenConditions: "Full sun, drip irrigation",
      plantings: [PLANTING],
    },
  ],
  finished: [],
  unassigned: [],
});

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("locationGardenSections", () => {
  it("is absent when the location has no gardenKind", () => {
    const sections = locationGardenSections({
      id: LOCATION_ID,
      name: "Pantry shelf",
      gardenKind: null,
      gardenConditions: null,
    });
    expect(sections).toEqual([]);
  });

  it("shows kind, conditions, and plantings from the overview when gardenKind is set", () => {
    harness = createBrowserTestHarness();
    const overviewOptions = garden.overview.queryOptions(undefined);
    harness.queryClient.setQueryDefaults(overviewOptions.queryKey, {
      staleTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(overviewOptions.queryKey, OVERVIEW);

    const entriesOptions = garden.entries.queryOptions({
      locationId: LOCATION_ID,
      page: 1,
    });
    harness.queryClient.setQueryDefaults(entriesOptions.queryKey, {
      staleTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(
      entriesOptions.queryKey,
      gardenEntriesOut.parse({ items: [], hasMore: false }),
    );

    const sections = locationGardenSections({
      id: LOCATION_ID,
      name: "Raised bed 1",
      gardenKind: "bed",
      gardenConditions: "Full sun, drip irrigation",
    });
    expect(sections).toHaveLength(1);
    const [section] = sections;

    render(section?.content, { wrapper: harness.wrapper });

    expect(screen.getByText("Raised bed")).toBeVisible();
    expect(screen.getByText("Full sun, drip irrigation")).toBeVisible();
    expect(screen.getByRole("link", { name: "Tomato · Roma" })).toHaveAttribute(
      "href",
      `/plantings/${PLANTING.id}`,
    );
  });
});

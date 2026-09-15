import { gardenOverviewOut } from "@cubby/schemas/garden";
import { gardenPlantingOut, plantingOut } from "@cubby/schemas/planting";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { GardenHome } from "./garden-home";
import { garden } from "./garden.functions";

function makePlanting(
  overrides: Partial<Parameters<typeof gardenPlantingOut.parse>[0]>,
) {
  return gardenPlantingOut.parse({
    id: testShortcode("planting", "PLT-4K7M"),
    ingredientId: testShortcode("ingredient", "ING-4K7M"),
    ingredientName: "Tomato",
    gardenGuideKey: null,
    sourceProductId: null,
    sourceProductName: null,
    intendedLocationId: null,
    intendedLocationName: null,
    parentPlantingId: null,
    locationId: testShortcode("location", "LOC-4K7M"),
    locationName: "Test bed",
    status: "growing",
    variety: null,
    quantity: null,
    notes: null,
    plannedWindow: null,
    plannedDate: null,
    sowedOn: null,
    transplantedOn: null,
    finishedOn: null,
    displayName: "Tomato",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

describe("Garden home overview", () => {
  it("lists the unassigned group after the located areas and hides the empty finished disclosure", async () => {
    const harness = createBrowserTestHarness();
    const located = makePlanting({
      id: testShortcode("planting", "PLT-4K7M"),
      ingredientName: "Tomato",
    });
    const unassigned = makePlanting({
      id: testShortcode("planting", "PLT-9Q2X"),
      ingredientName: "Basil",
      locationId: null,
      locationName: null,
    });
    const overview = garden.overview.withTransport(async () =>
      gardenOverviewOut.parse({
        locations: [
          {
            id: testShortcode("location", "LOC-4K7M"),
            name: "Test bed",
            gardenKind: "bed",
            gardenConditions: null,
            plantings: [located],
          },
        ],
        finished: [],
        unassigned: [unassigned],
      }),
    );
    try {
      render(
        <GardenHome
          operations={{ overview, finishPlanting: garden.finishPlanting }}
        />,
        { wrapper: harness.wrapper },
      );
      const headings = (
        await screen.findAllByRole("heading", { level: 2 })
      ).map((heading) => heading.textContent);
      const bedIndex = headings.findIndex((text) => text?.includes("Test bed"));
      const unassignedIndex = headings.findIndex((text) =>
        text?.includes("No location yet"),
      );
      expect(bedIndex).toBeGreaterThanOrEqual(0);
      expect(unassignedIndex).toBeGreaterThan(bedIndex);
      expect(screen.getByText("Basil")).toBeVisible();
      expect(screen.queryByText(/Finished plantings/)).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("reports a partial finish and pluralizes the bulk-finish submit label", async () => {
    const harness = createBrowserTestHarness();
    const keep = makePlanting({
      id: testShortcode("planting", "PLT-4K7M"),
      ingredientName: "Tomato",
    });
    const fail = makePlanting({
      id: testShortcode("planting", "PLT-9Q2X"),
      ingredientName: "Basil",
    });
    const overview = garden.overview.withTransport(async () =>
      gardenOverviewOut.parse({
        locations: [
          {
            id: testShortcode("location", "LOC-4K7M"),
            name: "Test bed",
            gardenKind: "bed",
            gardenConditions: null,
            plantings: [keep, fail],
          },
        ],
        finished: [],
        unassigned: [],
      }),
    );
    const finishPlanting = garden.finishPlanting.withTransport(
      async ({ input }) => {
        const data = garden.finishPlanting.definition.input.parse(input);
        if (data.plantingId === fail.id)
          throw new Error("Server rejected this planting.");
        return plantingOut.parse({ ...keep, images: [] });
      },
    );
    try {
      render(<GardenHome operations={{ overview, finishPlanting }} />, {
        wrapper: harness.wrapper,
      });
      fireEvent.click(
        await screen.findByRole("checkbox", { name: /Select Tomato/ }),
      );
      fireEvent.click(screen.getByRole("checkbox", { name: /Select Basil/ }));
      fireEvent.click(
        screen.getByRole("button", { name: "Finish selected (2)" }),
      );
      expect(
        await screen.findByRole("button", { name: "Finish 2 plantings" }),
      ).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "Finish 2 plantings" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Finished 1 planting of 2 plantings.",
        ),
      );
    } finally {
      harness.dispose();
    }
  });
});

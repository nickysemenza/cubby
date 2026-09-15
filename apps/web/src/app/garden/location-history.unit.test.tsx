import { plantingOut } from "@cubby/schemas/planting";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { garden } from "./garden.functions";
import {
  PlantingLocationHistory,
  type PlantingLocationPeriods,
} from "./location-history";

const planting = plantingOut.parse({
  id: testShortcode("planting", "PLT-4K7M"),
  ingredientId: testShortcode("ingredient", "ING-4K7M"),
  locationId: testShortcode("location", "LOC-4K7M"),
  sourceProductId: null,
  intendedLocationId: null,
  parentPlantingId: null,
  status: "growing",
  variety: null,
  quantity: null,
  notes: null,
  plannedWindow: null,
  plannedDate: null,
  sowedOn: null,
  transplantedOn: null,
  finishedOn: null,
  images: [],
  displayName: "Test crop",
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** `PlantingLocationHistory` reads `periods` from its caller (`PlantingDetail`
 * loads them) rather than querying on its own, so a test wrapper holds them
 * in state and refreshes from `onSaved` — mirroring the real owner's
 * "reload after the correct-dates mutation succeeds" behavior. */
function Harness({
  initialPeriods,
  latestPeriods,
  correctLocationDates,
  planting: overridePlanting,
}: {
  initialPeriods: PlantingLocationPeriods;
  /** Ref-like accessor for the mock transport's most recently written
   * periods, read inside `onSaved` once the mutation has resolved. */
  latestPeriods: () => PlantingLocationPeriods;
  correctLocationDates: typeof garden.correctLocationDates;
  planting?: typeof planting;
}) {
  const [periods, setPeriods] = useState(initialPeriods);
  return (
    <PlantingLocationHistory
      planting={overridePlanting ?? planting}
      locationName="Test bed"
      periods={periods}
      correctLocationDates={correctLocationDates}
      onSaved={() => setPeriods(latestPeriods())}
    />
  );
}

describe("Confirming existing planting history", () => {
  it("creates the first period only after the user enters and saves a date", async () => {
    const harness = createBrowserTestHarness();
    const requests: unknown[] = [];
    let savedPeriods: PlantingLocationPeriods = [];
    const correctLocationDates = garden.correctLocationDates.withTransport(
      async ({ input }) => {
        const submitted =
          garden.correctLocationDates.definition.input.parse(input);
        requests.push(submitted);
        savedPeriods = submitted.periods.map((period) => ({
          ...period,
          endedOn: period.endedOn ?? null,
          locationId: testShortcode("location", "LOC-4K7M"),
          locationName: "Test bed",
          startKind: "actual" as const,
        }));
        return { periods: savedPeriods };
      },
    );
    try {
      render(
        <Harness
          initialPeriods={[]}
          latestPeriods={() => savedPeriods}
          correctLocationDates={correctLocationDates}
        />,
        {
          wrapper: harness.wrapper,
        },
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm location dates" }),
      );
      expect(requests).toEqual([]);
      expect(screen.getByLabelText("In this location since")).toHaveValue("");
      fireEvent.change(screen.getByLabelText("In this location since"), {
        target: { value: "2026-04-13" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Save location dates" }),
      );
      await waitFor(() =>
        expect(requests).toEqual([
          {
            plantingId: planting.id,
            periods: [
              { sequence: 0, inLocationSince: "2026-04-13", endedOn: null },
            ],
          },
        ]),
      );
      expect(await screen.findByText(/Here since Apr 13, 2026/)).toBeVisible();
    } finally {
      harness.dispose();
    }
  });

  it("does not offer confirmed presence for a planned planting", async () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <Harness
          initialPeriods={[]}
          latestPeriods={() => []}
          correctLocationDates={garden.correctLocationDates}
          planting={{ ...planting, status: "planned" }}
        />,
        { wrapper: harness.wrapper },
      );
      expect(
        await screen.findByText(
          /Starting a planting records its first location/,
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Confirm location dates" }),
      ).toBeNull();
    } finally {
      harness.dispose();
    }
  });
});

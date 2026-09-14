import { plantingOut } from "@cubby/schemas/planting";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { garden } from "./garden.functions";
import { PlantingLocationHistory } from "./location-history";

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
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("Confirming existing planting history", () => {
  it("creates the first period only after the user enters and saves a date", async () => {
    const harness = createBrowserTestHarness();
    let periods: Awaited<
      ReturnType<typeof garden.locationHistory.call>
    >["periods"] = [];
    const requests: unknown[] = [];
    const operations = {
      locationHistory: garden.locationHistory.withTransport(async () => ({
        periods,
      })),
      correctLocationDates: garden.correctLocationDates.withTransport(
        async ({ input }) => {
          const submitted =
            garden.correctLocationDates.definition.input.parse(input);
          requests.push(submitted);
          periods = submitted.periods.map((period) => ({
            ...period,
            endedOn: period.endedOn ?? null,
            locationId: testShortcode("location", "LOC-4K7M"),
            locationName: "Test bed",
            startKind: "actual",
          }));
          return { periods };
        },
      ),
    };
    try {
      render(
        <PlantingLocationHistory
          planting={planting}
          locationName="Test bed"
          operations={operations}
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
      expect(await screen.findByText(/Here since 2026-04-13/)).toBeVisible();
    } finally {
      harness.dispose();
    }
  });

  it("does not offer confirmed presence for a planned planting", async () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <PlantingLocationHistory
          planting={{ ...planting, status: "planned" }}
          operations={{
            locationHistory: garden.locationHistory.withTransport(async () => ({
              periods: [],
            })),
            correctLocationDates: garden.correctLocationDates,
          }}
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

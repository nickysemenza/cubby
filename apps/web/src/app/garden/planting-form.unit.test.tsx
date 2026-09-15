import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { gardenStrings } from "./garden-strings";
import { garden } from "./garden.functions";
import { PlantingForm } from "./planting-form";

const loadOptions = garden.options.withTransport(async () => ({
  locations: [
    {
      id: testShortcode("location", "LOC-4K7M"),
      name: "Test bed",
      gardenKind: "bed",
      gardenConditions: null,
    },
  ],
  ingredients: [
    {
      id: testShortcode("ingredient", "ING-4K7M"),
      name: "Tomato",
      gardenGuideKey: null,
    },
  ],
  products: [],
  plantings: [],
}));

describe("Planting capture", () => {
  it("hides the current-location picker once Planned is chosen", async () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <PlantingForm
          onSaved={() => {}}
          onCancel={() => {}}
          loadOptions={loadOptions}
        />,
        { wrapper: harness.wrapper },
      );
      expect(
        screen.getByRole("combobox", {
          name: gardenStrings.planting.locationField,
        }),
      ).toBeVisible();
      fireEvent.change(
        screen.getByLabelText(gardenStrings.planting.stateField),
        { target: { value: "planned" } },
      );
      expect(
        screen.queryByRole("combobox", {
          name: gardenStrings.planting.locationField,
        }),
      ).toBeNull();
      // The destination picker (shown regardless of state) stays available,
      // once its collapsed "Dates and other details" section is opened.
      fireEvent.click(
        screen.getByText(gardenStrings.planting.datesDetailsSummary),
      );
      expect(
        screen.getByRole("combobox", {
          name: gardenStrings.planting.intendedDestinationField,
        }),
      ).toBeVisible();
    } finally {
      harness.dispose();
    }
  });

  it("keeps the submit disabled until a crop is chosen", async () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <PlantingForm
          onSaved={() => {}}
          onCancel={() => {}}
          loadOptions={loadOptions}
        />,
        { wrapper: harness.wrapper },
      );
      const submit = screen.getByRole("button", {
        name: gardenStrings.planting.submitAdd,
      });
      expect(submit).toBeDisabled();

      // Planned needs no current location, so choosing Crop alone should
      // be enough once state is switched off the "Growing now" default.
      fireEvent.change(
        screen.getByLabelText(gardenStrings.planting.stateField),
        { target: { value: "planned" } },
      );
      expect(submit).toBeDisabled();

      const crop = screen.getByRole("combobox", {
        name: gardenStrings.planting.cropField,
      });
      crop.focus();
      fireEvent.keyDown(crop, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: /Tomato/ }));

      await waitFor(() => expect(submit).not.toBeDisabled());
    } finally {
      harness.dispose();
    }
  });
});

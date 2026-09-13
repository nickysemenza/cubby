import { infLocation } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { LocationBasicInfo } from "./location-basic-info";

it("renders location facts without sending image and valuation projections through scalar rendering", () => {
  const harness = createBrowserTestHarness();
  const location = infLocation.parse({
    id: testShortcode("location", "LOC-2222"),
    name: "Kitchen pantry",
    aliases: [],
    type: "room",
    product: null,
    lastBulkInventory: null,
    aiDescription: null,
    gardenKind: null,
    gardenConditions: null,
    images: [],
    valuation: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  try {
    render(<LocationBasicInfo location={location} onEdit={() => {}} />, {
      wrapper: harness.wrapper,
    });
    expect(screen.getByText("Kitchen pantry")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Show all room locations" }),
    ).toBeVisible();
  } finally {
    harness.dispose();
  }
});

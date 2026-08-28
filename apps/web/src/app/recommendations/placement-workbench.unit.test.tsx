import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inventory } from "~/app/inventory/inventory.functions";
import { recommendations } from "~/lib/recommendations.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  productionRecommendationWorkbenchOperations,
  RecommendationWorkbench,
} from "./recommendation-workbench";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("RecommendationWorkbench placement", () => {
  it("does not move inventory until the recommendation is explicitly accepted", async () => {
    const inventoryId = testShortcode("inventory", "INV-PARKED");
    const destinationId = testShortcode("location", "LOC-SHELF");
    const moves: Array<{
      items: Array<{ inventoryEntryId: string; targetLocationId: string }>;
    }> = [];
    const operations = {
      ...productionRecommendationWorkbenchOperations,
      placement: recommendations.placement.withTransport(async () => ({
        inventoryId,
        productName: "Widget",
        sourceLocation: {
          id: testShortcode("location", "LOC-UNKNOWN"),
          name: "Unknown",
        },
        destination: {
          id: destinationId,
          name: "Shelf",
        },
      })),
      moveEntries: inventory.moveEntries.withTransport(async ({ input }) => {
        moves.push(input);
        return new Promise<never>(() => undefined);
      }),
    };

    render(
      <RecommendationWorkbench
        inventoryId={inventoryId}
        kind="placement"
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );

    const move = await screen.findByRole("button", { name: "Move to Shelf" });
    expect(moves).toEqual([]);
    fireEvent.click(move);

    await waitFor(() =>
      expect(moves).toEqual([
        {
          items: [
            {
              inventoryEntryId: inventoryId,
              targetLocationId: destinationId,
            },
          ],
        },
      ]),
    );
  });
});

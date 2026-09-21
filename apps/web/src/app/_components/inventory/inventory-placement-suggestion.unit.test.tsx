import { entityRecommendationsOut } from "@cubby/schemas/entity-recommendations";
import { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inventory } from "~/app/inventory/inventory.functions";
import { recommendations } from "~/lib/recommendations.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { InventoryPlacementSuggestion } from "./inventory-placement-suggestion";

const INVENTORY_ID = testShortcode("inventory", "INV-PARK");
const SURVIVING_INVENTORY_ID = testShortcode("inventory", "INV-PNTR");
const UNKNOWN_ID = testShortcode("location", "LOC-UNKN");
const PANTRY_ID = testShortcode("location", "LOC-PNTR");
const now = new Date("2026-09-01T00:00:00.000Z");
const inventoryitem = inventoryWithLocationAndProductOut.parse({
  id: INVENTORY_ID,
  amount: { value: 2, unit: "each" },
  valuation: null,
  verifiedAt: null,
  placement: "stock",
  ownershipMode: "inherit",
  ownerLedgerPartyId: null,
  effectiveOwnership: {
    mode: "inherit",
    explicitOwner: null,
    effectiveOwner: null,
    source: "unresolved",
    basis: null,
    evidence: null,
    evidenceFingerprint: "fixture-unresolved",
    matchesInheritedOwner: false,
  },
  createdAt: now,
  updatedAt: now,
  displayName: "Canned tomatoes · Unknown",
  location: {
    id: UNKNOWN_ID,
    name: "Unknown",
    type: "room",
    aliases: [],
    lastBulkInventory: null,
    product: null,
    aiDescription: null,
    notes: null,
    images: [],
    valuation: null,
    createdAt: now,
    updatedAt: now,
  },
  product: {
    id: testShortcode("product", "PRD-TMTO"),
    name: "Canned tomatoes",
    manufacturer: "Test kitchen",
    model: null,
    notes: null,
    primaryGtin: null,
    fdc_id: null,
    expectedQuantity: null,
    category: "food",
    price: null,
    usdaUnavailable: null,
    images: [],
    externalIds: [],
    unitMappings: [],
    createdAt: now,
    updatedAt: now,
  },
});
const recommendation = entityRecommendationsOut.parse({
  source: { entityType: "inventory", entityId: INVENTORY_ID },
  basisKey: "parked-at-unknown",
  groups: [
    {
      kind: "inventory-placement",
      status: "ready",
      currentTarget: { id: UNKNOWN_ID, name: "Unknown" },
      proposals: [
        {
          kind: "inventory-placement",
          inventoryId: INVENTORY_ID,
          target: { id: PANTRY_ID, name: "Pantry" },
          reasons: ["This product is usually stored in Pantry."],
        },
      ],
    },
  ],
});

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness({
    initialPath: `/inventory/${INVENTORY_ID}`,
  });
});
afterEach(() => harness.dispose());

describe("InventoryPlacementSuggestion", () => {
  it("previews the move and sends the existing atomic move payload only after apply", async () => {
    const move = vi.fn(async () => ({
      items: [
        {
          ...inventoryitem,
          id: SURVIVING_INVENTORY_ID,
          location: {
            ...inventoryitem.location,
            id: PANTRY_ID,
            name: "Pantry",
          },
          displayName: "Canned tomatoes · Pantry",
        },
      ],
      sideEffects: { backgroundBatches: [] },
    }));
    render(
      <InventoryPlacementSuggestion
        inventoryitem={inventoryitem}
        recommendationOperations={{
          forEntity: recommendations.forEntity.withTransport(
            async () => recommendation,
          ),
        }}
        moveOperation={inventory.moveEntries.withTransport(move)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pantry" }));
    expect(move).not.toHaveBeenCalled();
    expect(screen.getByText("Current:").parentElement).toHaveTextContent(
      "Unknown",
    );
    expect(screen.getByText("Proposed:").parentElement).toHaveTextContent(
      "Pantry",
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            items: [
              {
                inventoryEntryId: INVENTORY_ID,
                targetLocationId: PANTRY_ID,
                quantity: { value: 2, unit: "each" },
              },
            ],
          },
        }),
      ),
    );
    await waitFor(() =>
      expect(harness.router.state.location.pathname).toBe(
        `/inventory/${SURVIVING_INVENTORY_ID}`,
      ),
    );
  });

  it("shows the mutation error and retains the proposed move", async () => {
    render(
      <InventoryPlacementSuggestion
        inventoryitem={inventoryitem}
        recommendationOperations={{
          forEntity: recommendations.forEntity.withTransport(
            async () => recommendation,
          ),
        }}
        moveOperation={inventory.moveEntries.withTransport(async () => {
          throw new Error("Move service unavailable");
        })}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pantry" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Move service unavailable",
    );
    expect(screen.getByRole("button", { name: "Apply change" })).toBeVisible();
  });
});

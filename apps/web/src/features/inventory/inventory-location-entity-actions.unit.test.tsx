import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { inventoryLocationEntityActionDefinitions } from "./inventory-location-entity-actions";

const inventoryRow = {
  id: testShortcode("inventory", "INV-4K7M"),
  amount: { value: 2, unit: "each" },
  location: {
    id: testShortcode("location", "LOC-4K7M"),
    name: "Garage shelf",
  },
  product: { name: "Router gasket" },
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function MoveInventoryActionHarness({
  onResolved,
}: {
  onResolved: (success: boolean) => void;
}) {
  const action = inventoryLocationEntityActionDefinitions[0].use();
  const stageMove = () => {
    const pending = action.run?.([inventoryRow]);
    if (pending) void pending.then((result) => onResolved(result.success));
  };

  return (
    <>
      <button type="button" onClick={stageMove}>
        Stage inventory move
      </button>
      {action.dialog}
    </>
  );
}

describe("inventory and location action catalog", () => {
  it("keeps declared action order and surfaces stable", () => {
    expect(
      inventoryLocationEntityActionDefinitions.map(({ id }) => id),
    ).toEqual([
      "move-inventory",
      "print-location-labels",
      "move-location-under",
    ]);
    expect(inventoryLocationEntityActionDefinitions[0]).toMatchObject({
      entities: ["inventory"],
      surfaces: ["row", "selection", "inspector", "detail"],
    });
  });

  it("parses a selected inventory row before opening the real move dialog", async () => {
    const resolved: boolean[] = [];
    render(
      <MoveInventoryActionHarness
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage inventory move" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Move 1 Item?" }),
    ).toBeVisible();
    expect(screen.getByText("Router gasket - 2 each")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(resolved).toEqual([false]));
  });
});

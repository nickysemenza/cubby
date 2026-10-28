import { inventoryListItemOut } from "@cubby/schemas/entities/inventory";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";

import { inventoryLocationEntityActionDefinitions } from "./inventory-location-entity-actions";

const inventoryRow = {
  id: testShortcode("inventory", "INV-4K7M"),
  fields: {
    amount: fieldValueFixture(inventoryListItemOut.shape.fields.shape.amount, {
      value: 2,
      unit: "each",
    }),
    locationId: fieldValueFixture(
      inventoryListItemOut.shape.fields.shape.locationId,
      testShortcode("location", "LOC-4K7M"),
    ),
  },
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
  row = inventoryRow,
}: {
  onResolved: (success: boolean) => void;
  row?: typeof inventoryRow;
}) {
  const action = inventoryLocationEntityActionDefinitions[0].use();
  const availability = action.availability?.({
    entity: "inventory",
    surface: "selection",
    rows: [row],
  });
  const stageMove = () => {
    const pending = action.run?.([row]);
    if (pending) void pending.then((result) => onResolved(result.success));
  };

  return (
    <>
      <output aria-label="Move availability">
        {availability?.status === "disabled"
          ? availability.reason
          : availability?.status}
      </output>
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
  it("refuses a missing quantity without inventing a move snapshot", async () => {
    const resolved: boolean[] = [];
    const missing = fieldValueFixture(
      inventoryListItemOut.shape.fields.shape.amount,
      undefined,
    );
    render(
      <MoveInventoryActionHarness
        row={{
          ...inventoryRow,
          fields: {
            ...inventoryRow.fields,
            amount: {
              ...missing,
              work: {
                kind: "failed",
                error: "Synthetic quantity failure",
                retryAt: null,
              },
            },
          },
        }}
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Stage inventory move" }),
    );
    await waitFor(() => expect(resolved).toEqual([false]));
    expect(
      screen.queryByRole("heading", { name: "Move 1 Item?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Move availability")).toHaveTextContent(
      "Synthetic quantity failure",
    );
  });
});

import type { LocationInventoryBreakdownOut } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { location } from "~/app/locations/location.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  LocationInventoryBreakdown,
  type LocationInventoryBreakdownOperations,
} from "./location-inventory-breakdown";

const rootId = testShortcode("location", "LOC-ROOT");
const descendantTree: LocationInventoryBreakdownOut = {
  id: rootId,
  name: "Workshop",
  type: "room",
  directItemCount: 1,
  totalItemCount: 3,
  children: [
    {
      id: testShortcode("location", "LOC-CHLD"),
      name: "Shelf",
      type: "shelf",
      directItemCount: 2,
      totalItemCount: 2,
      children: [],
    },
  ],
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function renderBreakdown(
  hasChildren: boolean,
  operations: LocationInventoryBreakdownOperations,
) {
  return render(
    <LocationInventoryBreakdown
      shortcode={rootId}
      hasChildren={hasChildren}
      operations={operations}
    />,
    { wrapper: harness.routerWrapper },
  );
}

describe("LocationInventoryBreakdown", () => {
  it("does not request or render a breakdown for a leaf location", () => {
    let requests = 0;
    const operations = {
      inventoryBreakdown: location.inventoryBreakdown.withTransport(
        async () => {
          requests += 1;
          return descendantTree;
        },
      ),
    } satisfies LocationInventoryBreakdownOperations;

    const { container } = renderBreakdown(false, operations);

    expect(container).toBeEmptyDOMElement();
    expect(requests).toBe(0);
  });

  it("renders a compact loading state while the descendant tree loads", async () => {
    const operations = {
      inventoryBreakdown: location.inventoryBreakdown.withTransport(
        async () =>
          await new Promise<LocationInventoryBreakdownOut | null>(() => {}),
      ),
    } satisfies LocationInventoryBreakdownOperations;

    renderBreakdown(true, operations);

    expect(
      await screen.findByLabelText("Loading contents breakdown"),
    ).toBeInTheDocument();
  });

  it("offers a retry when the count tree fails", async () => {
    let requests = 0;
    const operations = {
      inventoryBreakdown: location.inventoryBreakdown.withTransport(
        async () => {
          requests += 1;
          throw new Error("unavailable");
        },
      ),
    } satisfies LocationInventoryBreakdownOperations;

    renderBreakdown(true, operations);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requests).toBe(2));
  });

  it("renders a drill-down only when stock exists below the current location", async () => {
    const operations = {
      inventoryBreakdown: location.inventoryBreakdown.withTransport(
        async () => descendantTree,
      ),
    } satisfies LocationInventoryBreakdownOperations;

    renderBreakdown(true, operations);

    expect(
      await screen.findByRole("region", { name: "Contents breakdown" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Workshop")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open location Shelf: 2 items/ }),
    ).toBeVisible();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RecordPaths } from "./connected-records-table";

describe("record connection evidence", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });

  it("links the shortest witnessed route and expands other routes", () => {
    render(
      <RecordPaths
        paths={[
          [
            {
              entityKind: "plant",
              entityId: "PLT-TEST",
              label: "Example crop",
            },
            {
              entityKind: "product",
              entityId: "PRD-SEED",
              label: "Example seeds",
            },
            {
              entityKind: "purchase",
              entityId: "PUR-TEST",
              label: "Example order",
            },
          ],
          [
            {
              entityKind: "plant",
              entityId: "PLT-TEST",
              label: "Example crop",
            },
            {
              entityKind: "product",
              entityId: "PRD-SEED",
              label: "Example seeds",
            },
            {
              entityKind: "expense",
              entityId: "EXP-TEST",
              label: "Example expense",
            },
            {
              entityKind: "purchase",
              entityId: "PUR-TEST",
              label: "Example order",
            },
          ],
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Via Direct connection · 2 paths" }),
    );
    expect(
      screen.getAllByRole("link", { name: "Example seeds" })[0],
    ).toHaveAttribute("href", "/products/PRD-SEED");
    expect(
      screen.getByRole("link", { name: "Example expense" }),
    ).toHaveAttribute("href", "/expenses/EXP-TEST");
    expect(
      screen.getAllByRole("link", { name: "Example order" })[0],
    ).toHaveAttribute("href", "/purchases/PUR-TEST");
  });

  it("explains a connection whose evidence passes through storage-only rows", () => {
    render(
      <RecordPaths
        paths={[
          [
            {
              entityKind: "email",
              entityId: "EML-TEST",
              label: "Synthetic tracking email",
            },
            {
              entityKind: "shipment",
              entityId: "SHIP-TEST",
              label: "Synthetic parcel",
              via: {
                relationshipKey: "tracking-emails",
                label: "Tracking evidence",
                sourceKey: "direct",
                provenance: ["incoming:ShipmentObservation.shipmentId"],
              },
            },
          ],
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Via Tracking evidence" }),
    );
    expect(
      screen.getByRole("link", { name: "Synthetic parcel" }),
    ).toHaveAttribute("href", "/shipments/SHIP-TEST");
  });
});

import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { describe, expect, it } from "vitest";

import { reconcileShipmentTimeline, shipmentMilestones } from "./timeline";

const event = (
  kind: ShipmentObservationInput["kind"],
  value: string,
): ShipmentObservationInput => ({
  kind,
  time: { kind: "instant", value },
  sourceEventKey: null,
  rawStatus: "Synthetic carrier status",
  location: null,
  carrierId: null,
  carrierName: "Synthetic Carrier",
  trackingNumber: "EXAMPLE-123",
});

describe("shipment evidence reconciliation", () => {
  it("combines clear duplicate reports without losing their source handles", () => {
    const delivery = event("delivered", "2026-06-06T09:00:00Z");
    const result = reconcileShipmentTimeline([
      { id: "one", event: delivery, superseded: false },
      {
        id: "two",
        event: { ...delivery, rawStatus: "Your package arrived" },
        superseded: false,
      },
      { id: "old", event: delivery, superseded: true },
    ]);
    expect(result).toEqual([
      { event: delivery, observationIds: ["one", "two"] },
    ]);
  });

  it("retains repeated scans with unknown times as separate occurrences", () => {
    const scan: ShipmentObservationInput = {
      ...event("in_transit", "2026-06-03T09:00:00Z"),
      time: { kind: "unknown" },
    };
    expect(
      reconcileShipmentTimeline([
        { id: "one", event: scan, superseded: false },
        { id: "two", event: scan, superseded: false },
      ]),
    ).toHaveLength(2);
  });

  it("measures transit across carrier handoffs using first possession", () => {
    const result = shipmentMilestones(
      [
        event("vendor_shipped", "2026-06-02T09:00:00Z"),
        event("carrier_possession", "2026-06-03T09:00:00Z"),
        event("carrier_possession", "2026-06-04T09:00:00Z"),
        event("delivered", "2026-06-06T09:00:00Z"),
      ],
      "2026-06-01T09:00:00Z",
    );
    expect(result).toMatchObject({
      fulfillmentHours: 48,
      transitHours: 72,
      totalWaitHours: 120,
    });
  });

  it("does not substitute a label or vendor shipped event for possession", () => {
    expect(
      shipmentMilestones(
        [
          event("label_created", "2026-06-02T09:00:00Z"),
          event("vendor_shipped", "2026-06-02T09:00:00Z"),
          event("delivered", "2026-06-06T09:00:00Z"),
        ],
        "2026-06-01T09:00:00Z",
      ),
    ).toMatchObject({
      carrierPossessionAt: null,
      fulfillmentHours: null,
      transitHours: null,
      totalWaitHours: 120,
    });
  });

  it("preserves unknown date precision and conflicting delivery reports", () => {
    const result = shipmentMilestones(
      [
        event("carrier_possession", "2026-06-03T09:00:00Z"),
        event("delivered", "2026-06-06T09:00:00Z"),
        event("delivered", "2026-06-06T11:00:00Z"),
      ],
      "2026-06-01",
    );
    expect(result).toMatchObject({
      deliveredAt: null,
      fulfillmentHours: null,
      transitHours: null,
      totalWaitHours: null,
    });
    expect(result.conflicts).toContain(
      "Sources report different delivery times.",
    );
  });
});

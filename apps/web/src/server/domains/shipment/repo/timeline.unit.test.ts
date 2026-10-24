import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { describe, expect, it } from "vitest";

import {
  reconcileShipmentTimeline,
  shipmentEventSummary,
  shipmentMilestones,
} from "./timeline";

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
  it("keeps forecast and notification dates out of exact delivery milestones", () => {
    const forecast = {
      ...event("delivered", "2026-06-06T09:00:00Z"),
      timeBasis: "estimate",
    } satisfies ShipmentObservationInput;
    const notification = {
      ...forecast,
      timeBasis: "notification_received",
    } satisfies ShipmentObservationInput;
    expect(shipmentMilestones([forecast], null).deliveredAt).toBeNull();
    expect(shipmentMilestones([notification], null).deliveredAt).toBeNull();
    const timeline = reconcileShipmentTimeline([
      { id: "forecast", event: forecast, superseded: false },
      { id: "notification", event: notification, superseded: false },
      {
        id: "stated",
        event: { ...forecast, timeBasis: "stated_event" },
        superseded: false,
      },
    ]);
    expect(timeline).toHaveLength(3);
    expect(shipmentEventSummary(timeline).eventCount).toBe(3);
    expect(
      shipmentEventSummary([{ event: forecast, observationIds: ["forecast"] }]),
    ).toMatchObject({
      eventCount: 1,
      firstEventDate: "2026-06-06",
      lastEventDate: "2026-06-06",
    });
  });

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

  it("summarizes distinct current events without substituting unknown event times", () => {
    const first = event("label_created", "2026-06-01T09:00:00Z");
    const last = event("delivered", "2026-06-03T10:30:00Z");
    const unknown = {
      ...first,
      time: { kind: "unknown" },
    } satisfies ShipmentObservationInput;
    const timeline = reconcileShipmentTimeline([
      { id: "first", event: first, superseded: false },
      { id: "duplicate", event: first, superseded: false },
      { id: "last", event: last, superseded: false },
      { id: "unknown", event: unknown, superseded: false },
      {
        id: "old",
        event: event("delivered", "2026-06-09T00:00:00Z"),
        superseded: true,
      },
    ]);
    expect(shipmentEventSummary(timeline)).toEqual({
      firstEventDate: "2026-06-01",
      lastEventDate: "2026-06-03",
      eventSpanHours: 49.5,
      eventSpanLabel: "49.5h",
      eventCount: 3,
    });
    expect(shipmentEventSummary(timeline.slice(0, 1))).toMatchObject({
      eventSpanHours: null,
    });
    expect(shipmentEventSummary([])).toEqual({
      firstEventDate: null,
      lastEventDate: null,
      eventSpanHours: null,
      eventSpanLabel: null,
      eventCount: 0,
    });
  });

  it("uses a single local event's date for both endpoints without inventing elapsed hours", () => {
    const local = {
      ...event("delivered", "2026-06-03T09:00:00Z"),
      time: {
        kind: "local",
        value: "2026-06-03T09:00:00",
        timezone: "America/Los_Angeles",
      },
    } satisfies ShipmentObservationInput;
    expect(
      shipmentEventSummary(
        reconcileShipmentTimeline([
          { id: "local", event: local, superseded: false },
        ]),
      ),
    ).toEqual({
      firstEventDate: "2026-06-03",
      lastEventDate: "2026-06-03",
      eventSpanHours: null,
      eventSpanLabel: null,
      eventCount: 1,
    });
  });

  it("keeps calendar-day precision for coarse endpoints, including mixed time precision", () => {
    const coarse = {
      ...event("label_created", "2026-06-01T00:00:00Z"),
      time: { kind: "date", value: "2026-06-01" },
    } satisfies ShipmentObservationInput;
    const local = {
      ...coarse,
      time: { kind: "local", value: "June 5 morning", timezone: null },
    } satisfies ShipmentObservationInput;
    const summary = (last: ShipmentObservationInput) =>
      shipmentEventSummary(
        reconcileShipmentTimeline([
          { id: "first", event: coarse, superseded: false },
          { id: "last", event: last, superseded: false },
          { id: "local", event: local, superseded: false },
        ]),
      );
    expect(
      summary({ ...coarse, time: { kind: "date", value: "2026-06-03" } }),
    ).toMatchObject({
      firstEventDate: "2026-06-01",
      lastEventDate: "2026-06-03",
      eventSpanHours: 48,
      eventSpanLabel: "2d",
      eventCount: 3,
    });
    expect(
      summary(event("delivered", "2026-06-03T23:30:00-02:00")),
    ).toMatchObject({
      eventSpanHours: 48,
      eventSpanLabel: "2d",
    });
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

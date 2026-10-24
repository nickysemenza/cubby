import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  shipmentEvidence,
  retainedShipmentEvidence,
} from "./shipment-evidence";
import { mailResolveInput } from "./mailbox-research";

import {
  importExtractionModelOutput,
  extractedPurchaseLine,
  extractedOrderCandidate,
  importAuditModelOutput,
  importExtractionOutcome,
  importSourceIdentity,
  normalizeImportExtractionModelOutput,
  normalizeImportAuditModelOutput,
  proposedImportFix,
} from "./purchase-import";

describe("purchase import contracts", () => {
  const packet = shipmentEvidence.parse({
    shipmentId: null,
    sourceShipmentKey: "parcel-1",
    distinctPackageEvidence: "Package 1 of 2: replacement filter",
    carrierId: null,
    carrierName: "Synthetic Courier",
    trackingNumber: "SYN-TRACK-101",
    extraTrackingNumbers: [],
    purpose: "incoming",
    observations: [
      {
        sourceEventKey: null,
        kind: "vendor_shipped",
        timeBasis: "stated_event",
        time: { kind: "local", value: "2026-10-20T10:30", timezone: null },
        rawStatus: "Your first package has shipped",
        location: null,
        carrierId: null,
        carrierName: "Synthetic Courier",
        trackingNumber: "SYN-TRACK-101",
      },
    ],
  });
  const order = {
    orderId: "SYN-ORDER-101",
    orderedAt: null,
    merchant: "Synthetic Supplies",
    currency: "USD",
    printedGrandTotal: null,
    lines: [],
    payments: [],
  };

  it("retains historical booleans verbatim without inventing package evidence", () => {
    const legacy = { ...order, allShipmentsDelivered: true };
    expect(extractedOrderCandidate.parse(legacy)).toEqual(legacy);
    expect(extractedOrderCandidate.parse(legacy)).not.toHaveProperty(
      "shipments",
    );
  });

  it("preserves historical purpose text in retained extraction but refuses it as a live direction", () => {
    const retained = {
      ...order,
      shipments: [{ ...packet, purpose: "replacement" }],
    };
    expect(extractedOrderCandidate.parse(retained)).toEqual(retained);
    expect(shipmentEvidence.safeParse(retained.shipments[0]).success).toBe(
      false,
    );
  });

  it("keeps historical observation JSON literal while requiring provenance for fresh packets", () => {
    const historical = {
      ...packet,
      observations: packet.observations.map(
        ({ timeBasis: _basis, ...event }) => event,
      ),
    };
    expect(retainedShipmentEvidence.parse(historical)).toEqual(historical);
    expect(shipmentEvidence.safeParse(historical).success).toBe(false);
  });

  it("normalizes structured package evidence without inventing a timezone or whole-order delivery", () => {
    const output = normalizeImportExtractionModelOutput(
      importExtractionModelOutput.parse({
        status: "ready",
        reason: null,
        detail: null,
        candidate: { ...order, shipments: [packet] },
      }),
    );
    expect(output.candidate?.shipments).toEqual([packet]);
    expect(output.candidate).not.toHaveProperty("allShipmentsDelivered");
    const candidateSchema = z.toJSONSchema(importExtractionModelOutput);
    expect(JSON.stringify(candidateSchema)).not.toContain(
      "allShipmentsDelivered",
    );
    expect(() =>
      importExtractionModelOutput.parse({
        status: "ready",
        reason: null,
        detail: null,
        candidate: order,
      }),
    ).toThrow(/shipments/);
  });

  it("refuses an unidentified trackingless package but retains a distinct source package", () => {
    expect(() =>
      extractedOrderCandidate.parse({
        ...order,
        shipments: [
          {
            ...packet,
            trackingNumber: null,
            sourceShipmentKey: null,
          },
        ],
      }),
    ).toThrow("stable source shipment key");
    expect(
      extractedOrderCandidate.parse({
        ...order,
        shipments: [
          {
            ...packet,
            trackingNumber: null,
          },
        ],
      }).shipments?.[0]?.distinctPackageEvidence,
    ).toBe(packet.distinctPackageEvidence);
  });

  it("requires linked shipment packets to name a selected Purchase", () => {
    const input = {
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-shipping",
      checksum: "a".repeat(64),
      disposition: {
        kind: "linked",
        event: "shipped",
        purchaseIds: ["PUR-ABCDE"],
        shipments: [{ purchaseId: "PUR-ABCDF", shipments: [packet] }],
      },
    };
    expect(() => mailResolveInput.parse(input)).toThrow("linked Purchase");
    expect(
      mailResolveInput.parse({
        ...input,
        disposition: {
          ...input.disposition,
          shipments: [{ purchaseId: "PUR-ABCDE", shipments: [packet] }],
        },
      }).disposition.kind,
    ).toBe("linked");
  });

  it("retains a typed candidate when an extraction needs review", () => {
    const outcome = importExtractionOutcome.parse({
      status: "needs_review",
      reason: "sum_mismatch",
      detail: "Printed total differs from the extracted lines.",
      candidate: {
        orderId: "ORDER-100",
        orderedAt: "2026-09-19T12:00:00.000Z",
        merchant: "Example Supply",
        currency: "USD",
        printedGrandTotal: 24,
        lines: [{ title: "Replacement filter", amount: 20 }],
        payments: [],
        allShipmentsDelivered: null,
      },
    });

    expect(outcome).toMatchObject({ status: "needs_review" });
    if (outcome.status !== "needs_review")
      throw new Error("Expected review outcome");
    expect(outcome.candidate.lines).toHaveLength(1);
  });

  it("uses an OpenAI-compatible flat schema for extraction output", () => {
    expect(
      JSON.stringify(z.toJSONSchema(importExtractionModelOutput)),
    ).not.toContain('"oneOf"');
  });

  it("keeps the audit wire schema portable and validates decoded fixes", () => {
    const schema = JSON.stringify(z.toJSONSchema(importAuditModelOutput));
    expect(schema).not.toMatch(/"oneOf"|"minimum"|"maximum"/);
    const finding = {
      kind: "wrong_product",
      targetPurchaseId: "00000000-0000-4000-8000-000000000001",
      summary: "The linked product is a different variant.",
      probability: 0.95,
    };
    expect(
      normalizeImportAuditModelOutput(
        importAuditModelOutput.parse({
          findings: [
            {
              ...finding,
              proposedFixJson: JSON.stringify({
                kind: "relink_product",
                expenseId: "00000000-0000-4000-8000-000000000002",
                productId: "00000000-0000-4000-8000-000000000003",
              }),
            },
          ],
        }),
      ).findings[0]?.proposedFix,
    ).toMatchObject({ kind: "relink_product" });
    expect(() =>
      normalizeImportAuditModelOutput(
        importAuditModelOutput.parse({
          findings: [
            {
              ...finding,
              proposedFixJson: JSON.stringify({
                kind: "create_refund",
                purchaseId: finding.targetPurchaseId,
                amount: -10,
                title: "Unsupported refund",
              }),
            },
          ],
        }),
      ),
    ).toThrow("Audit cannot propose create_refund");
  });

  it("keeps absent model roles undecided while preserving historical parse defaults", () => {
    const wire = importExtractionModelOutput.parse({
      status: "ready",
      reason: null,
      detail: null,
      candidate: {
        orderId: "ORDER-101",
        orderedAt: "2026-09-20T12:00:00.000Z",
        merchant: "Example Supply",
        currency: "USD",
        printedGrandTotal: 24,
        lines: [
          {
            title: "Replacement filter",
            amount: 24,
            lineKind: null,
            costType: null,
            quantity: null,
            productUrl: null,
            imageUrl: null,
            sku: null,
            seller: null,
          },
        ],
        payments: [
          {
            amount: 24,
            chargedAt: null,
            cardLastFour: null,
            tender: null,
            description: null,
          },
        ],
        shipments: [],
      },
    });

    const normalized = normalizeImportExtractionModelOutput(wire);
    expect(normalized).toEqual({
      status: "ready",
      candidate: {
        orderId: "ORDER-101",
        orderedAt: "2026-09-20T12:00:00.000Z",
        merchant: "Example Supply",
        currency: "USD",
        printedGrandTotal: 24,
        lines: [
          {
            title: "Replacement filter",
            amount: 24,
            lineKind: "unclassified",
          },
        ],
        payments: [{ amount: 24 }],
        shipments: [],
      },
    });

    // Historical extraction rows used the required domain default. Replays
    // continue to decode that stored shape with its original meaning.
    expect(
      extractedPurchaseLine.parse({ title: "Replacement filter", amount: 24 })
        .lineKind,
    ).toBe("principal");
  });

  it("requires stable source identity for orderless receipts", () => {
    expect(() =>
      importSourceIdentity.parse({
        kind: "receipt_photo",
        externalKey: "",
        checksum: "not-a-checksum",
      }),
    ).toThrow("Too small");
  });

  it("allows only a negative refund proposal", () => {
    const base = {
      kind: "create_refund" as const,
      purchaseId: crypto.randomUUID(),
      title: "Refund",
    };
    expect(() => proposedImportFix.parse({ ...base, amount: 10 })).toThrow(
      "refund must be negative",
    );
    const refund = proposedImportFix.parse({ ...base, amount: -10 });
    if (refund.kind !== "create_refund") throw new Error("Expected refund fix");
    expect(refund.amount).toBe(-10);
  });
});

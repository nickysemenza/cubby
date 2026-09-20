import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  browserBridgeRequest,
  importExtractionModelOutput,
  importExtractionOutcome,
  importSourceIdentity,
  normalizeImportExtractionModelOutput,
  proposedImportFix,
} from "./purchase-import";

describe("purchase import contracts", () => {
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

  it("normalizes OpenAI null placeholders into optional domain fields", () => {
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
            description: null,
          },
        ],
        allShipmentsDelivered: null,
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
            lineKind: "principal",
          },
        ],
        payments: [{ amount: 24 }],
        allShipmentsDelivered: null,
      },
    });
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

  it("does not expose arbitrary click or script browser operations", () => {
    expect(() =>
      browserBridgeRequest.parse({
        requestId: crypto.randomUUID(),
        operation: "evaluate",
        script: "document.forms[0].submit()",
      }),
    ).toThrow("Invalid input");
    expect(() =>
      browserBridgeRequest.parse({
        requestId: crypto.randomUUID(),
        operation: "click",
        selector: "button",
      }),
    ).toThrow("Invalid input");
  });

  it("preserves the bounded recovery URL for a restart-safe capture", () => {
    const request = browserBridgeRequest.parse({
      protocolVersion: 2,
      id: crypto.randomUUID(),
      operationId: "capture-after-restart",
      runID: crypto.randomUUID(),
      deadline: "2026-09-21T12:00:00.000Z",
      operation: {
        type: "capture",
        allowedHosts: ["orders.example.test"],
        enhancedEvidence: false,
        recoveryURL: "https://orders.example.test/history",
      },
    });

    expect(request.operation).toMatchObject({
      type: "capture",
      recoveryURL: "https://orders.example.test/history",
    });
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

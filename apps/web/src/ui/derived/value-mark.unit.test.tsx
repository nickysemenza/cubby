import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FieldValueMark } from "./value-mark";

const snapshot = (
  receiptId: string,
  currentReceiptId: string,
): ReadableFieldEnvelope => ({
  current: {
    assignment: {
      kind: "value",
      value: "Blue",
      ownership: {
        kind: "automatic",
        receiptId: currentReceiptId,
        confidence: 0.9,
      },
    },
    controls: {
      kind: "editable",
      canSetNone: false,
      canConfirm: true,
      reset: { kind: "unavailable" },
    },
  },
  result: {
    kind: "cached",
    freshness: "stale",
    computedAt: "2026-10-01T12:00:00Z",
    decision: {
      outcome: { kind: "value", value: "Blue" },
      provenance: {
        kind: "own",
        ownership: { kind: "automatic", receiptId, confidence: 0.9 },
      },
    },
  },
  work: { kind: "idle" },
});

describe("field value automatic ownership", () => {
  it("marks the displayed decision automatic only when its receipt still owns the assignment", () => {
    render(
      <FieldValueMark
        envelope={snapshot("synthetic-receipt", "synthetic-receipt")}
      >
        Blue
      </FieldValueMark>,
    );
    expect(screen.getByText("auto")).toBeInTheDocument();
  });

  it("does not relabel an older cached decision with a new automatic receipt", () => {
    render(
      <FieldValueMark
        envelope={snapshot(
          "synthetic-earlier-receipt",
          "synthetic-current-receipt",
        )}
      >
        Blue
      </FieldValueMark>,
    );
    expect(screen.queryByText("auto")).not.toBeInTheDocument();
    expect(screen.getByText("Blue")).toBeInTheDocument();
  });
});

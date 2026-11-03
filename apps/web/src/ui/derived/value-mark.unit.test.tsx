import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
  it("pulses only an observed execution and stops at its lease expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T12:00:10Z"));
    const envelope = snapshot("synthetic-receipt", "synthetic-receipt");
    const view = render(
      <FieldValueMark envelope={{ ...envelope, work: { kind: "pending" } }}>
        Blue
      </FieldValueMark>,
    );
    try {
      expect(
        screen.getByLabelText("Queued for refresh").firstChild,
      ).not.toHaveClass("motion-safe:animate-pulse");
      // The mounted queued field keeps the shared minute clock subscribed.
      // Opening an already-expired observation must not trust that older tick.
      await act(async () => vi.advanceTimersByTime(10_000));
      view.rerender(
        <FieldValueMark
          envelope={{
            ...envelope,
            work: {
              kind: "pending",
              execution: {
                startedAt: "2026-11-03T12:00:00Z",
                leaseExpiresAt: "2026-11-03T12:00:15Z",
              },
            },
          }}
        >
          Blue
        </FieldValueMark>,
      );
      expect(
        screen.getByLabelText("Refresh status may be out of date").firstChild,
      ).not.toHaveClass("motion-safe:animate-pulse");
      view.rerender(
        <FieldValueMark
          envelope={{
            ...envelope,
            work: {
              kind: "pending",
              execution: {
                startedAt: "2026-11-03T12:00:20Z",
                leaseExpiresAt: "2026-11-03T12:00:25Z",
              },
            },
          }}
        >
          Blue
        </FieldValueMark>,
      );
      expect(screen.getByLabelText("Updating").firstChild).toHaveClass(
        "motion-safe:animate-pulse",
      );
      await act(async () => vi.advanceTimersByTime(5_000));
      expect(
        screen.getByLabelText("Refresh status may be out of date").firstChild,
      ).not.toHaveClass("motion-safe:animate-pulse");
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
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
    expect(screen.getByLabelText("Stale result")).toBeInTheDocument();
  });
});

import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { FieldRecordValue } from "~/ui/derived/record-value";

import { FieldResolutionEntityActions } from "./field-resolution";

const base: ReadableFieldEnvelope = {
  current: {
    assignment: { kind: "inherit" },
    controls: {
      kind: "editable",
      canSetNone: true,
      canConfirm: true,
      reset: { kind: "unavailable" },
    },
  },
  result: {
    kind: "live",
    decision: {
      outcome: { kind: "value", value: "plumbing" },
      provenance: {
        kind: "inherited",
        source: {
          entityKind: "purchase",
          entityId: testShortcode("purchase", "fixture-purchase"),
          name: "Synthetic purchase",
        },
      },
    },
  },
  work: { kind: "idle" },
};

it("keeps a server-approved reset action available before its exact preview is loaded", () => {
  const harness = createBrowserTestHarness();
  try {
    render(
      <FieldResolutionEntityActions
        entity="expense"
        id={testShortcode("expense", "clear-override")}
        field="trade"
        resolution={{
          ...base,
          current: {
            assignment: {
              kind: "value",
              value: "plumbing",
              ownership: { kind: "record" },
            },
            controls: {
              kind: "editable",
              canSetNone: true,
              canConfirm: false,
              reset: { kind: "available", preview: { kind: "not_loaded" } },
            },
          },
        }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("button", { name: "Use inherited" })).toBeVisible();
  } finally {
    harness.dispose();
  }
});

it("keeps inherited provenance visible while refresh work changes independently", () => {
  const record = {
    id: testShortcode("expense", "synthetic-envelope"),
    fields: { trade: { ...base, work: { kind: "pending" } } },
  };
  const view = render(
    <FieldRecordValue record={record} field="trade">
      Plumbing
    </FieldRecordValue>,
  );
  expect(screen.getByLabelText("Updating")).toBeVisible();
  expect(screen.getByLabelText("Inherited")).toBeVisible();
  view.rerender(
    <FieldRecordValue
      record={{ ...record, fields: { trade: base } }}
      field="trade"
    >
      Plumbing
    </FieldRecordValue>,
  );
  expect(screen.queryByLabelText("Updating")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Inherited")).toBeVisible();
});

it("retains cached provenance and the raw failure alongside stale status", () => {
  if (base.result.kind !== "live")
    throw new Error("Missing synthetic live decision");
  const error = "Synthetic SQLSTATE 40001: refresh failed";
  render(
    <FieldRecordValue
      record={{
        fields: {
          trade: {
            ...base,
            result: {
              kind: "cached",
              decision: base.result.decision,
              computedAt: "2026-10-01T00:00:00Z",
              freshness: "stale",
            },
            work: { kind: "failed", error, retryAt: null },
          },
        },
      }}
      field="trade"
    >
      Plumbing
    </FieldRecordValue>,
  );
  expect(screen.getByText("Plumbing")).toBeVisible();
  expect(screen.getByLabelText("Inherited")).toBeVisible();
  expect(screen.getByLabelText("Updating")).toBeVisible();
  expect(screen.getByRole("button", { name: error })).toBeVisible();
});

it("ends the automatic marker from current ownership without rewriting cached provenance", () => {
  const envelope: ReadableFieldEnvelope = {
    current: {
      ...base.current,
      assignment: {
        kind: "value",
        value: "plumbing",
        ownership: { kind: "record" },
      },
    },
    result: {
      kind: "cached",
      computedAt: "2026-10-01T00:00:00Z",
      freshness: "stale",
      decision: {
        outcome: { kind: "value", value: "plumbing" },
        provenance: {
          kind: "own",
          ownership: {
            kind: "automatic",
            receiptId: "synthetic-receipt",
            confidence: 0.9,
          },
        },
      },
    },
    work: { kind: "pending" },
  };
  render(
    <FieldRecordValue record={{ fields: { trade: envelope } }} field="trade">
      Plumbing
    </FieldRecordValue>,
  );
  expect(screen.queryByText("auto")).not.toBeInTheDocument();
  expect(envelope.result).toMatchObject({
    decision: { provenance: { ownership: { kind: "automatic" } } },
  });
});

it("distinguishes a missing computation from successful empty and retains its failure", () => {
  const view = render(
    <FieldRecordValue
      record={{ fields: { trade: { ...base, result: { kind: "missing" } } } }}
      field="trade"
    >
      Not recorded
    </FieldRecordValue>,
  );
  expect(screen.getByText("Updating…")).toBeVisible();
  expect(screen.queryByText("Not recorded")).not.toBeInTheDocument();
  const error = "Synthetic initial computation failed";
  view.rerender(
    <FieldRecordValue
      record={{
        fields: {
          trade: {
            ...base,
            result: { kind: "missing" },
            work: { kind: "failed", error, retryAt: null },
          },
        },
      }}
      field="trade"
    >
      Not recorded
    </FieldRecordValue>,
  );
  expect(screen.getByText("Unavailable")).toBeVisible();
  expect(screen.getByRole("button", { name: error })).toBeVisible();
  view.rerender(
    <FieldRecordValue
      record={{
        fields: {
          trade: {
            ...base,
            result: {
              kind: "live",
              decision: {
                outcome: { kind: "empty", reason: "explicit_none" },
                provenance: null,
              },
            },
          },
        },
      }}
      field="trade"
    >
      None
    </FieldRecordValue>,
  );
  expect(screen.getByText("None")).toBeVisible();
  expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
});

import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import { testShortcode } from "@cubby/schemas/testing";
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";

import {
  renderWithEditorMetadata as render,
  createEditorBrowserTestHarness as createBrowserTestHarness,
} from "#web/tests/editor-metadata.fixtures.ts";
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

it("distinguishes a missing computation from successful empty", () => {
  const view = render(
    <FieldRecordValue
      record={{ fields: { trade: { ...base, result: { kind: "missing" } } } }}
      field="trade"
    >
      Not recorded
    </FieldRecordValue>,
  );
  expect(screen.getByLabelText("Not calculated yet")).toBeVisible();
  expect(screen.queryByText("Not recorded")).not.toBeInTheDocument();
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
  expect(screen.queryByLabelText("Not calculated yet")).not.toBeInTheDocument();
});

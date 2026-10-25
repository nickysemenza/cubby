import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import {
  DerivedRecordValue,
  DerivedSidecarProvider,
} from "~/ui/derived/sidecar-context";

import { FieldResolutionEntityActions } from "./field-resolution";

const sourceId = testShortcode("purchase", "fixture-purchase");
const base: FieldResolution = {
  mode: "inherit",
  storedValue: null,
  value: "plumbing",
  fallbackValue: "plumbing",
  source: "purchase default",
  sourceEntity: {
    entityKind: "purchase",
    entityId: sourceId,
    name: "Synthetic purchase",
  },
  matchesFallback: false,
  canReset: false,
};

describe("field resolution indicators", () => {
  it("keeps a server-approved clear action available when there is no inherited value", () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <FieldResolutionEntityActions
          entity="expense"
          id={testShortcode("expense", "clear-override")}
          field="trade"
          resolution={{
            ...base,
            mode: "explicit",
            storedValue: "plumbing",
            fallbackValue: null,
            sourceEntity: null,
            canReset: true,
          }}
        />,
        { wrapper: harness.wrapper },
      );
      expect(
        screen.getByRole("button", { name: "Clear value" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: "Use inherited",
        }),
      ).not.toBeInTheDocument();
    } finally {
      harness.dispose();
    }
  });
});

it("shows published freshness immediately and lets sidecar provenance override the transitional resolution", () => {
  const id = testShortcode("expense", "synthetic-sidecar");
  const record = { id, fieldResolutions: { trade: base } };
  const view = render(
    <DerivedSidecarProvider
      value={{
        [id]: {
          trade: { state: "stale", decidedBy: { level: "own" }, asOf: null },
        },
      }}
    >
      <DerivedRecordValue record={record} field="trade">
        Plumbing
      </DerivedRecordValue>
    </DerivedSidecarProvider>,
  );
  expect(screen.getByLabelText("Updating")).toBeVisible();
  expect(screen.queryByLabelText("Inherited")).not.toBeInTheDocument();
  view.rerender(
    <DerivedRecordValue record={record} field="trade">
      Plumbing
    </DerivedRecordValue>,
  );
  expect(screen.queryByLabelText("Updating")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Inherited")).toBeVisible();
  view.rerender(
    <DerivedSidecarProvider
      value={{
        [id]: {
          trade: { state: "stale", decidedBy: { level: "own" }, asOf: null },
        },
      }}
    >
      <DerivedRecordValue
        record={{
          ...record,
          derived: {
            trade: { state: "fresh", decidedBy: { level: "own" }, asOf: null },
          },
        }}
        field="trade"
      >
        Plumbing
      </DerivedRecordValue>
    </DerivedSidecarProvider>,
  );
  expect(screen.queryByLabelText("Updating")).not.toBeInTheDocument();
});

import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  FieldResolutionBadge,
  FieldResolutionStatus,
  resolutionIsInformative,
} from "./field-resolution";

const sourceId = testShortcode("purchase", "fixture-purchase");
const base: FieldResolution = {
  mode: "inherit",
  storedValue: null,
  value: "plumbing",
  fallbackValue: "plumbing",
  source: "purchase default",
  sourceEntity: { entityKind: "purchase", entityId: sourceId, name: null },
  matchesFallback: false,
  canReset: false,
};

describe("field resolution indicators", () => {
  it("keeps a server-approved clear action available when there is no inherited value", () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <FieldResolutionBadge
          field="trade"
          record={{
            id: testShortcode("expense", "clear-override"),
            fieldResolutions: {
              trade: {
                ...base,
                mode: "explicit",
                storedValue: "plumbing",
                fallbackValue: null,
                sourceEntity: null,
                canReset: true,
              },
            },
          }}
        />,
        { wrapper: harness.wrapper },
      );
      expect(
        screen.getByRole("button", { name: "Clear override" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: "Use inherited value",
        }),
      ).not.toBeInTheDocument();
    } finally {
      harness.dispose();
    }
  });
  // Regression: an empty inherited value rendered "Unassigned" beside its
  // "—", and a top-level task's own project rendered "Override · Use
  // inherited value" although resetting would only clear it.
  it.each<[string, Partial<FieldResolution>, boolean]>([
    ["inherited value", {}, true],
    ["empty inherited value", { value: null, sourceEntity: null }, false],
    [
      "explicit over a fallback",
      { mode: "explicit", value: "electrical", canReset: true },
      true,
    ],
    [
      "explicit with nothing to inherit",
      { mode: "explicit", fallbackValue: null, canReset: true },
      false,
    ],
    [
      "redundant explicit",
      { mode: "explicit", matchesFallback: true, canReset: true },
      true,
    ],
    ["explicit none over a fallback", { mode: "none", value: null }, true],
    [
      "explicit none with nothing to inherit",
      { mode: "none", value: null, fallbackValue: null },
      false,
    ],
    ["allocated", { mode: "allocated" }, true],
  ])("%s → informative %s", (_name, patch, informative) => {
    expect(resolutionIsInformative({ ...base, ...patch })).toBe(informative);
  });

  it("keeps table provenance compact without losing its accessible meaning", () => {
    render(<FieldResolutionStatus resolution={base} compact />);
    expect(screen.getByText("purchase default")).toHaveClass("sr-only");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  // Regression: the source rendered as a bare shortcode link with no mark.
  it("names the source record in detail provenance", () => {
    const harness = createBrowserTestHarness();
    try {
      render(<FieldResolutionStatus resolution={base} />, {
        wrapper: harness.wrapper,
      });
      expect(screen.getByText("From purchase")).toBeInTheDocument();
      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", `/purchases/${sourceId}`);
      expect(link.querySelector("svg, img")).not.toBeNull();
    } finally {
      harness.dispose();
    }
  });
});

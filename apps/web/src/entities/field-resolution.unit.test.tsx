import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { FieldResolutionStatus } from "./field-resolution";

const sourceId = testShortcode("purchase", "fixture-purchase");
const resolution = {
  mode: "inherit" as const,
  storedValue: null,
  value: null,
  fallbackValue: null,
  source: "purchase default",
  sourceEntity: { entityType: "purchase" as const, entityId: sourceId },
  matchesFallback: false,
  canReset: false,
};

describe("field resolution indicators", () => {
  it("keeps table provenance compact without losing its accessible meaning", () => {
    render(<FieldResolutionStatus resolution={resolution} compact />);
    expect(screen.getByText("purchase default")).toHaveClass("sr-only");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links detail provenance to the source purchase", () => {
    const harness = createBrowserTestHarness();
    try {
      render(<FieldResolutionStatus resolution={resolution} />, {
        wrapper: harness.wrapper,
      });
      expect(screen.getByRole("link", { name: sourceId })).toHaveAttribute(
        "href",
        `/purchases/${sourceId}`,
      );
    } finally {
      harness.dispose();
    }
  });
});

import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ResolutionExplanation } from "./field-resolution-explanation";

const purchaseId = testShortcode("purchase", "fixture-purchase");

describe("ResolutionExplanation", () => {
  it("flags a redundant override and shows the enum label, not the raw key", () => {
    render(
      <ResolutionExplanation
        entity="expense"
        field="trade"
        resolution={{
          mode: "explicit",
          storedValue: "other",
          value: "other",
          fallbackValue: "other",
          source: "expense override",
          sourceEntity: null,
          matchesFallback: true,
          canReset: true,
        }}
      />,
    );
    expect(screen.getByText("Override on this expense")).toBeInTheDocument();
    expect(
      screen.getByText("Same value — the override is redundant."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Other")).toHaveLength(2);
    expect(screen.queryByText("other")).not.toBeInTheDocument();
  });

  it("shows nothing-to-inherit when an override has no fallback", () => {
    render(
      <ResolutionExplanation
        entity="expense"
        field="trade"
        resolution={{
          mode: "explicit",
          storedValue: "electrical",
          value: "electrical",
          fallbackValue: null,
          source: "expense override",
          sourceEntity: null,
          matchesFallback: false,
          canReset: true,
        }}
      />,
    );
    expect(screen.getByText("Without the override")).toBeInTheDocument();
    expect(screen.getByText("Nothing to inherit")).toBeInTheDocument();
    expect(
      screen.queryByText("Same value — the override is redundant."),
    ).not.toBeInTheDocument();
  });

  it("links an inherited value to its purchase source and offers the reset hint", () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <ResolutionExplanation
          entity="expense"
          field="trade"
          resolution={{
            mode: "inherit",
            storedValue: null,
            value: "building",
            fallbackValue: "building",
            source: "purchase default",
            sourceEntity: { entityType: "purchase", entityId: purchaseId },
            matchesFallback: false,
            canReset: false,
          }}
        />,
        { wrapper: harness.wrapper },
      );
      expect(screen.getByRole("link", { name: purchaseId })).toHaveAttribute(
        "href",
        `/purchases/${purchaseId}`,
      );
      expect(screen.getByText("Building & Framing")).toBeInTheDocument();
      expect(screen.getByText(/Purchase default/)).toBeInTheDocument();
      expect(screen.getByText("Stored on this expense")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Change it on the linked purchase, or set an override here.",
        ),
      ).toBeInTheDocument();
    } finally {
      harness.dispose();
    }
  });

  it("renders an explicitly-cleared value with no second row", () => {
    render(
      <ResolutionExplanation
        entity="task"
        field="projectId"
        resolution={{
          mode: "none",
          storedValue: null,
          value: null,
          fallbackValue: null,
          source: "Task override",
          sourceEntity: null,
          matchesFallback: false,
          canReset: true,
        }}
      />,
    );
    expect(screen.getByText(/Task override/)).toBeInTheDocument();
    expect(screen.queryByText("Without the override")).not.toBeInTheDocument();
    expect(screen.queryByText("Stored on this task")).not.toBeInTheDocument();
  });
});

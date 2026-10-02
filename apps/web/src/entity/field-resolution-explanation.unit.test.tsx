import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ResolutionExplanation } from "./field-resolution-explanation";

const purchaseId = testShortcode("purchase", "fixture-purchase");

describe("ResolutionExplanation", () => {
  it("explains a system-derived reimbursement without inventing a purchase allocation", () => {
    render(
      <ResolutionExplanation
        entity="financialTransaction"
        field="evidenceExpectation"
        resolution={{
          mode: "allocated",
          storedValue: "required",
          value: "not_expected",
          fallbackValue: "not_expected",
          source: "reviewed reimbursement",
          sourceEntity: null,
          matchesFallback: true,
          canReset: true,
        }}
      />,
    );
    expect(screen.getByText("Not expected")).toBeInTheDocument();
    expect(screen.getByText(/Reviewed reimbursement/)).toBeInTheDocument();
    expect(screen.getByText("Expected")).toBeInTheDocument();
    expect(
      screen.queryByText("Allocated across the purchase"),
    ).not.toBeInTheDocument();
  });
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
    expect(screen.getByText("Redundant")).toBeInTheDocument();
    expect(screen.getAllByText("Other")).toHaveLength(2);
    expect(screen.queryByText("other")).not.toBeInTheDocument();
  });

  it("calls a value with nothing above it set here, not an override", () => {
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
    expect(screen.getByText("Set here")).toBeInTheDocument();
    expect(screen.queryByText(/override/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/inherit/i)).not.toBeInTheDocument();
  });

  it("names the inherited value an override replaces", () => {
    render(
      <ResolutionExplanation
        entity="expense"
        field="trade"
        resolution={{
          mode: "explicit",
          storedValue: "electrical",
          value: "electrical",
          fallbackValue: "building",
          source: "expense override",
          sourceEntity: null,
          matchesFallback: false,
          canReset: true,
        }}
      />,
    );
    expect(screen.getByText("Overrides inherited")).toBeInTheDocument();
    expect(screen.getByText("Building & Framing")).toBeInTheDocument();
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
            sourceEntity: {
              entityKind: "purchase",
              entityId: purchaseId,
              name: null,
            },
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
      expect(screen.getByText("Inherited")).toBeInTheDocument();
      expect(screen.getByText(/Purchase default/)).toBeInTheDocument();
    } finally {
      harness.dispose();
    }
  });

  it("explains an explicitly-cleared value and the absence of a fallback", () => {
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
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.queryByText(/override/i)).not.toBeInTheDocument();
  });

  it("ladders the hierarchy: the subject wins and an assigned ancestor is shadowed", () => {
    const self = testShortcode("productCategory", "fixture-paper");
    const parent = testShortcode("productCategory", "fixture-household");
    const root = testShortcode("productCategory", "fixture-home");
    const node = (id: string, name: string, value: string | null) => ({
      label: "Product category ancestry",
      entity: { entityKind: "productCategory" as const, entityId: id },
      value: { name, value, assigned: value !== null },
    });
    const harness = createBrowserTestHarness();
    try {
      render(
        <ResolutionExplanation
          entity="productCategory"
          id={self}
          field="feature"
          resolution={{
            mode: "explicit",
            storedValue: "supplies",
            value: "supplies",
            fallbackValue: "food",
            source: "Permanent feature binding",
            sourceEntity: null,
            matchesFallback: false,
            canReset: false,
          }}
          evidence={{
            hierarchy: [
              node(self, "Paper goods", "supplies"),
              node(parent, "Household", null),
              node(root, "Home", "food"),
            ],
            fallbackSource: {
              entityKind: "productCategory",
              entityId: root,
              name: "Home",
            },
          }}
        />,
        { wrapper: harness.wrapper },
      );
      const rows = screen.getAllByRole("listitem");
      expect(rows.map((row) => row.dataset.role)).toEqual([
        "wins",
        "unset",
        "shadowed",
      ]);
      expect(rows[0]).toHaveTextContent("Paper goods");
      expect(rows[2]).toHaveTextContent("Home");
    } finally {
      harness.dispose();
    }
  });
});

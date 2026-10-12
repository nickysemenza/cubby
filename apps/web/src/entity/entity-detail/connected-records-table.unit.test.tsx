import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RecordPaths } from "./connected-records-table";

describe("record connection evidence", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });

  it("links the shortest witnessed route and expands other routes", () => {
    render(
      <RecordPaths
        paths={[
          [
            {
              entityKind: "plant",
              entityId: "PLT-TEST",
              label: "Example crop",
            },
            {
              entityKind: "product",
              entityId: "PRD-SEED",
              label: "Example seeds",
            },
            {
              entityKind: "purchase",
              entityId: "PUR-TEST",
              label: "Example order",
            },
          ],
          [
            {
              entityKind: "plant",
              entityId: "PLT-TEST",
              label: "Example crop",
            },
            {
              entityKind: "product",
              entityId: "PRD-SEED",
              label: "Example seeds",
            },
            {
              entityKind: "expense",
              entityId: "EXP-TEST",
              label: "Example expense",
            },
            {
              entityKind: "purchase",
              entityId: "PUR-TEST",
              label: "Example order",
            },
          ],
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    const product = screen.getAllByRole("link", { name: "Product" })[0];
    expect(product).toHaveAttribute("href", "/products/PRD-SEED");
    expect(product?.closest("[title]")).toHaveAttribute(
      "title",
      "Product: Example seeds",
    );
    expect(screen.queryByText("Example order")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+1 path" }));
    expect(screen.getByRole("link", { name: "Expense" })).toHaveAttribute(
      "href",
      "/expenses/EXP-TEST",
    );
  });

  it("names every intermediate record by its kind", () => {
    render(
      <RecordPaths
        paths={[
          [
            { entityKind: "vendor", entityId: "VEN-TEST", label: "Example" },
            {
              entityKind: "product",
              entityId: "PRD-TEST",
              label: "Example long product name",
            },
            {
              entityKind: "expense",
              entityId: "EXP-TEST",
              label: "Example long product name",
            },
            { entityKind: "purchase", entityId: "PUR-TEST", label: "Order" },
          ],
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("link", { name: "Product" })).toHaveAttribute(
      "href",
      "/products/PRD-TEST",
    );
    expect(
      screen.queryByText("Example long product name"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Expense" })).toHaveAttribute(
      "href",
      "/expenses/EXP-TEST",
    );
  });
});

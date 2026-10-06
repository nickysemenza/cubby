import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { HopRange, RecordPaths } from "./connected-records-table";

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
    expect(
      screen.getAllByRole("link", { name: "Example seeds" })[0],
    ).toHaveAttribute("href", "/products/PRD-SEED");
    expect(screen.queryByText("Example order")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+1 path" }));
    expect(
      screen.getByRole("link", { name: "Example expense" }),
    ).toHaveAttribute("href", "/expenses/EXP-TEST");
  });

  it("names a repeated label by its kind instead of repeating it", () => {
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
    expect(
      screen.getByRole("link", { name: "Example long product name" }),
    ).toHaveAttribute("href", "/products/PRD-TEST");
    expect(screen.getByRole("link", { name: "Expense" })).toHaveAttribute(
      "href",
      "/expenses/EXP-TEST",
    );
  });

  it("shows a range when a table has routes of different record lengths", () => {
    render(<HopRange range={{ min: 2, max: 3 }} />);
    expect(screen.getByText("2–3 record hops")).toBeVisible();
  });
});

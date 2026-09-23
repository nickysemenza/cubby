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
              entityType: "plant",
              entityId: "PLT-TEST",
              label: "Example crop",
            },
            {
              entityType: "product",
              entityId: "PRD-SEED",
              label: "Example seeds",
            },
            {
              entityType: "purchase",
              entityId: "PUR-TEST",
              label: "Example order",
            },
          ],
          [
            {
              entityType: "plant",
              entityId: "PLT-TEST",
              label: "Example crop",
            },
            {
              entityType: "product",
              entityId: "PRD-SEED",
              label: "Example seeds",
            },
            {
              entityType: "expense",
              entityId: "EXP-TEST",
              label: "Example expense",
            },
            {
              entityType: "purchase",
              entityId: "PUR-TEST",
              label: "Example order",
            },
          ],
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText(/^2 hops/u)).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: "Example seeds" })[0],
    ).toHaveAttribute("href", "/products/PRD-SEED");
    fireEvent.click(screen.getByText("1 other path"));
    expect(
      screen.getByRole("link", { name: "Example expense" }),
    ).toHaveAttribute("href", "/expenses/EXP-TEST");
  });

  it("shows a range when a table has routes of different record lengths", () => {
    render(<HopRange range={{ min: 2, max: 3 }} />);
    expect(screen.getByText("2–3 record hops")).toBeVisible();
  });
});

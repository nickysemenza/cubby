import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SavedViewChips } from "./EntityManifestGrid";

describe("SavedViewChips", () => {
  it("renders ordinary and problem-backed views in manifest order", () => {
    render(<SavedViewChips entity="product" />);

    const firstBadge = screen.getByText("Shelf disagrees");
    const problemBadge = screen.getByText("Stocked but unpriced");

    expect(firstBadge.compareDocumentPosition(problemBadge)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(firstBadge.querySelector("svg")).toBeNull();
    expect(problemBadge.querySelector("svg")).toHaveClass("text-warning");
    expect(
      within(firstBadge).queryByText("Also appears on the Problems page."),
    ).not.toBeInTheDocument();
    expect(
      within(problemBadge).getByText("Also appears on the Problems page."),
    ).toHaveClass("sr-only");
  });

  it("renders a dash when an entity declares no saved views", () => {
    render(<SavedViewChips entity="vendor" />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

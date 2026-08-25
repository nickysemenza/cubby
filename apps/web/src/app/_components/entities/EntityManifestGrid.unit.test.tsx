import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntityInspector, SavedViewChips } from "./EntityManifestGrid";

describe("SavedViewChips", () => {
  it("renders ordinary and problem-backed views in manifest order", () => {
    render(<SavedViewChips entity="product" />);

    const firstBadge = screen.getByText("Shelf disagrees");
    const problemBadge = screen.getByText("Stocked but unpriced");

    expect(firstBadge.compareDocumentPosition(problemBadge)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(firstBadge).toBeInTheDocument();
    expect(problemBadge).toBeInTheDocument();
  });

  it("renders a dash when an entity declares no saved views", () => {
    render(<SavedViewChips entity="vendor" />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("EntityInspector shortcode contracts", () => {
  it("shows the permanent Product printed-label alias as inbound-only", () => {
    render(<EntityInspector entity="product" count={12} />);

    expect(screen.getByText("Printed-label contract")).toBeInTheDocument();
    expect(screen.getAllByText("PRD-XXXX").length).toBeGreaterThan(0);
    expect(screen.getAllByText("P-XXXX").length).toBeGreaterThan(0);
    expect(screen.getByText(/permanent inbound rewrite/i)).toBeInTheDocument();
    expect(screen.getByText("inbound only")).toBeInTheDocument();
    expect(screen.getByText("permanent — printed labels")).toBeInTheDocument();
  });

  it("shows Location label compatibility and rejects a Recipe alias", () => {
    const { rerender } = render(
      <EntityInspector entity="location" count={3} />,
    );
    expect(screen.getAllByText("LOC-XXXX").length).toBeGreaterThan(0);
    expect(screen.getAllByText("L-XXXX").length).toBeGreaterThan(0);

    rerender(<EntityInspector entity="recipe" count={2} />);
    expect(screen.getAllByText("RCP-XXXX").length).toBeGreaterThan(0);
    expect(screen.queryByText("R-XXXX")).not.toBeInTheDocument();
    expect(screen.getByText(/removed R- form/i)).toBeInTheDocument();
  });

  it("reports compiled filters and current transport ownership", () => {
    render(<EntityInspector entity="product" count={12} />);

    expect(
      screen.getByText(/literal descriptors · generated bindings/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("detail · list/filter · generic writes"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "workflow procedures · batching/streams · specialized projections",
      ),
    ).toBeInTheDocument();
  });
});

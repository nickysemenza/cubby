import { render, screen, within } from "@testing-library/react";
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
      screen.getByText("explicit workflow extensions only"),
    ).toBeInTheDocument();
  });

  it("shows dedicated Start ownership for specialized browser projections", () => {
    const { rerender } = render(<EntityInspector entity="image" count={4} />);
    expect(
      screen.getByText("dedicated list · detail · writes"),
    ).toBeInTheDocument();

    rerender(<EntityInspector entity="usda-food" count={0} />);
    expect(screen.getByText("specialized list · detail")).toBeInTheDocument();
  });
});

describe("EntityInspector presentation", () => {
  it("shows the declaration's presentation block for a gallery entity", () => {
    render(<EntityInspector entity="product" count={12} />);

    expect(screen.getByText("pantry")).toBeInTheDocument();
    expect(
      screen.getByText("Specific household products and their identity."),
    ).toBeInTheDocument();
    expect(screen.getByText("Barcode")).toBeInTheDocument();
    expect(screen.getByText("shippingbox")).toBeInTheDocument();
    expect(screen.getByText("Nothing on the shelves yet")).toBeInTheDocument();
    expect(screen.getByText("Add Product")).toBeInTheDocument();
    expect(
      screen.getByText("gallery (ordered join table)"),
    ).toBeInTheDocument();
  });

  it("distinguishes cover-only images and an entity on no wayfinding line", () => {
    const { rerender } = render(
      <EntityInspector entity="cookbook" count={2} />,
    );
    expect(screen.getByText("cover (single coverImageId)")).toBeInTheDocument();

    rerender(<EntityInspector entity="image" count={5} />);
    expect(screen.getByText("none (no wayfinding line)")).toBeInTheDocument();
  });
});

describe("EntityInspector native coverage", () => {
  it("shows what the native client carries, distinct from what HTTP exposes", () => {
    render(<EntityInspector entity="product" count={12} />);

    expect(screen.getByText("Native app")).toBeInTheDocument();
    expect(screen.getByText("HTTP exposes")).toBeInTheDocument();
    expect(screen.getByText("Native client")).toBeInTheDocument();
    expect(screen.getByText("product.findOrCreateByUPC")).toBeInTheDocument();
    expect(screen.getByText("house (fallback)")).toBeInTheDocument();
  });

  it("renders the section for an entity the app never touches", () => {
    render(<EntityInspector entity="cookbook" count={2} />);
    expect(screen.getByText("Native app")).toBeInTheDocument();
  });
});

describe("EntityInspector sorting and edit intents", () => {
  it("shows Product's declared sort default and a computed sort field", () => {
    render(<EntityInspector entity="product" count={12} />);

    expect(screen.getByText("Sorting")).toBeInTheDocument();
    // `createdAt` (the default) also appears in the collapsed contract JSON,
    // so assert presence rather than uniqueness.
    expect(screen.getAllByText("createdAt").length).toBeGreaterThan(0);
    // `expenseTotal` is one of product's `computed` roster entries (no
    // `model.fields` read projection) in entity-sort.gen.ts; it also appears
    // in the "Fields" row above, so scope the assertion to "Computed".
    const computedRow = screen.getByText("Computed").closest("div");
    if (computedRow === null) throw new Error("Computed row not found");
    expect(within(computedRow).getByText("expenseTotal")).toBeInTheDocument();
  });

  it("renders the declared countFilter for the entity that has one", () => {
    // Only `ingredient` declares a non-null `countFilter` today
    // (`"recipeIdNull"`, set in 02-ingredient.entity.ts); re-grep
    // entity-definitions/*.entity.ts if this ever needs to move.
    render(<EntityInspector entity="ingredient" count={5} />);

    expect(screen.getByText("Count filter")).toBeInTheDocument();
    expect(screen.getByText("recipeIdNull")).toBeInTheDocument();
  });

  it("shows a dash for an entity with no declared countFilter", () => {
    render(<EntityInspector entity="product" count={12} />);

    const countFilterLabel = screen.getByText("Count filter");
    const row = countFilterLabel.closest("div");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("—");
  });

  it("renders an editable entity's create and update intents", () => {
    render(<EntityInspector entity="product" count={12} />);

    expect(screen.getByText("Edit intents")).toBeInTheDocument();
    expect(screen.getByText("Create intents")).toBeInTheDocument();
    expect(screen.getByText("Update intents")).toBeInTheDocument();
    // "capture" and "full" are both intent names AND per-intent row labels,
    // so multiple matches are expected.
    expect(screen.getAllByText("capture").length).toBeGreaterThan(0);
    expect(screen.getAllByText("full").length).toBeGreaterThan(0);
  });

  it("shows usda-food has no declared sort roster (hand roster) and is not browser-editable", () => {
    render(<EntityInspector entity="usda-food" count={0} />);

    expect(screen.getByText("Declared")).toBeInTheDocument();
    expect(screen.getByText("none (hand roster)")).toBeInTheDocument();
    expect(screen.getByText("not editable in the browser")).toBeInTheDocument();
  });
});

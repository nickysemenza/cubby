import { testShortcode } from "@cubby/schemas/testing";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { formatUnitPrice, UnitPriceLine } from "./unit-price-line";

/**
 * Renders against the REAL conversion kernel (the `ui` project loads actual
 * WASM, not a stub), so this exercises the same path the product page does.
 */
const mappingsFor = (
  price: number | null,
  unitMappings: {
    a: { value: number; unit: string };
    b: { value: number; unit: string };
  }[] = [],
) =>
  getAllUnitMappingsFromProduct({
    id: testShortcode("product", "PRD-2345"),
    unitMappings,
    food: null,
    price,
  });

const BAGGED_ONIONS = () =>
  mappingsFor(2.73, [
    { a: { value: 1, unit: "each" }, b: { value: 32, unit: "oz" } },
  ]);

describe("formatUnitPrice", () => {
  it("keeps sub-cent unit prices legible instead of rounding them to $0.00", () => {
    // The default 2-decimal money format renders $0.003/g as "$0.00", which
    // reads as free — worse than showing nothing at all.
    expect(formatUnitPrice(0.0030086)).toBe("$0.00301");
    expect(formatUnitPrice(0.0853125)).toBe("$0.085");
    expect(formatUnitPrice(15.29)).toBe("$15.29");
  });
});

describe("UnitPriceLine", () => {
  it("shows the per-ounce price for a bagged good", () => {
    render(<UnitPriceLine mappings={BAGGED_ONIONS()} />);
    expect(screen.getByText("Unit price")).toBeInTheDocument();
    // $2.73 / 32 oz.
    expect(screen.getByText("$0.085/oz")).toBeInTheDocument();
  });

  it("adds the per-gram figure as the cross-product comparator", () => {
    render(<UnitPriceLine mappings={BAGGED_ONIONS()} />);
    expect(screen.getByText("$0.00301/g")).toBeInTheDocument();
  });

  it("drops the label and the per-gram figure when compact", () => {
    render(<UnitPriceLine mappings={BAGGED_ONIONS()} compact />);
    expect(screen.queryByText("Unit price")).not.toBeInTheDocument();
    expect(screen.queryByText("$0.00301/g")).not.toBeInTheDocument();
    expect(screen.getByText("$0.085/oz")).toBeInTheDocument();
  });

  it("renders nothing when the graph has no path to money", () => {
    // A priceless product is the common case on an unenriched row; a blank is
    // the honest output, not a confident-looking zero.
    const { container } = render(
      <UnitPriceLine mappings={mappingsFor(null)} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a product with no mappings at all", () => {
    const { container } = render(<UnitPriceLine mappings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to per-each when nothing measurable is known", () => {
    render(<UnitPriceLine mappings={mappingsFor(178.29)} />);
    expect(screen.getByText("$178.29/each")).toBeInTheDocument();
  });
});

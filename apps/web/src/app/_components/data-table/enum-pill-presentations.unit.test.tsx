import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocationTypeLabel } from "~/app/_components/locations/LocationTypeLabel";
import { CategoryLabel } from "~/app/_components/products/CategoryLabel";
import { tradeOptions } from "~/app/projects/trade-options";

import { categorySummaryFixture } from "../../../../tooling/product-category-fixtures";
import { renderOptionCell } from "./columnHelpers";

afterEach(cleanup);

function pillFor(label: string) {
  const pill = screen.getByText(label).parentElement;
  if (!(pill instanceof HTMLElement)) {
    throw new Error(`Expected ${label} to render inside an enum pill`);
  }
  return pill;
}

describe("enum pill icons", () => {
  it("shows the existing category and location-type glyphs", () => {
    const category = render(
      <CategoryLabel category={categorySummaryFixture("supplies")} />,
    );
    expect(pillFor("Supplies").querySelectorAll("svg")).toHaveLength(1);
    category.unmount();

    render(<LocationTypeLabel type="drawer" product={null} />);
    expect(pillFor("drawer").querySelectorAll("svg")).toHaveLength(1);
  });

  it("uses an option-roster icon for a generic trade pill", () => {
    render(renderOptionCell("planning", tradeOptions));

    expect(pillFor("Planning").querySelectorAll("svg")).toHaveLength(1);
  });

  it("does not invent an icon for a text-only status", () => {
    render(
      renderOptionCell("done", [
        { value: "done", label: "Done", color: "var(--positive)" },
      ]),
    );

    expect(pillFor("Done").querySelector("svg")).toBeNull();
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TradeBadge } from "~/app/projects/trade-badge";
import { tradeOptions } from "~/app/projects/trade-options";
import { fieldEnumOptions } from "~/entity/enum-field-display";
import { CategoryLabel } from "~/features/products/CategoryLabel";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { categorySummaryFixture } from "../../../tooling/product-category-fixtures";
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
  it("uses the declared trade palette on task-board badges", () => {
    render(<TradeBadge trade="plumbing" />);
    expect(pillFor("Plumbing")).toHaveStyle(
      `--enum-pill-color: ${fieldEnumOptions("task", "trade").find((option) => option.value === "plumbing")?.color}`,
    );
    expect(pillFor("Plumbing").querySelectorAll("svg")).toHaveLength(1);
  });
  it("shows the existing category glyph", () => {
    const harness = createBrowserTestHarness();
    render(<CategoryLabel category={categorySummaryFixture("supplies")} />, {
      wrapper: harness.wrapper,
    });
    expect(pillFor("Supplies").querySelectorAll("svg")).toHaveLength(1);
    harness.dispose();
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

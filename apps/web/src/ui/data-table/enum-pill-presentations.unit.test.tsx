import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { enumDisplayValue } from "~/entity/display/enum-field-display";
import { CategoryLabel } from "~/entity/presentation/category-label";
import { TradeBadge } from "~/features/project/trade-badge";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { renderScalarValue } from "~/ui/common/scalar-value";
import { BooleanValue, EnumPill } from "~/ui/primitives/enum-pill";

import { categorySummaryFixture } from "../../../tooling/product-category-fixtures";
import { renderOptionCell } from "../../entity/table/column-helpers";

afterEach(cleanup);

function pillFor(label: string) {
  const pill = screen.getByText(label).closest<HTMLElement>("[data-enum-role]");
  if (!pill) throw new Error(`Expected ${label} to render as an enum value`);
  return pill;
}

describe("enum values by role", () => {
  it("draws supplied presentation without interpreting the stored word", () => {
    render(
      renderOptionCell("blocked", [
        {
          value: "blocked",
          label: "Available",
          role: "category",
          color: "var(--brand-domain-house)",
          glyph: { phosphor: "CheckCircle", sfSymbol: "checkmark.circle.fill" },
        },
      ]),
    );
    const pill = pillFor("Available");
    expect(pill).toHaveAttribute("data-enum-role", "category");
    expect(pill).toHaveClass("text-foreground", "border-transparent");
    expect(pill.style.backgroundColor).toContain("var(--brand-domain-house)");
    expect(
      pill.querySelector("[data-option-glyph='CheckCircle']"),
    ).not.toBeNull();
  });

  it("draws a kind on a quiet matching tint with readable label ink", () => {
    render(<EnumPill color="var(--category-3)">Credit card</EnumPill>);
    const pill = pillFor("Credit card");
    expect(pill).toHaveAttribute("data-enum-role", "category");
    expect(pill.style.backgroundColor).toContain("var(--category-3)");
    expect(pill).toHaveClass("text-foreground");
    expect(pill.className).not.toMatch(/positive|warning|destructive/);
  });

  it("keeps a declared role independent of color", () => {
    render(
      <EnumPill optionRole="category" color="var(--positive)">
        Other
      </EnumPill>,
    );
    expect(pillFor("Other")).toHaveAttribute("data-enum-role", "category");
  });

  it("reads a declared kind roster as categories with their glyphs", async () => {
    // The compiled roster owns the glyph across scalar and cell surfaces.
    const trade = entityFieldModels.task.fields.find(
      (field) => field.key === "trade",
    );
    if (!trade) throw new Error("Expected task.trade");
    render(
      <>
        {renderScalarValue(enumDisplayValue("task", trade, "planning"), "list")}
      </>,
    );
    const pill = pillFor("Planning");
    expect(pill).toHaveAttribute("data-enum-role", "category");
    await waitFor(() =>
      expect(
        pill.querySelector("svg[data-option-glyph='ClipboardText']"),
      ).not.toBeNull(),
    );
  });

  it("keeps caller-drawn marks on trade badges and category labels", async () => {
    const harness = createBrowserTestHarness();
    render(
      <>
        <TradeBadge trade="plumbing" />
        <CategoryLabel category={categorySummaryFixture("supplies")} />
      </>,
      { wrapper: harness.wrapper },
    );
    await waitFor(() =>
      expect(pillFor("Plumbing").querySelectorAll("svg")).toHaveLength(1),
    );
    expect(pillFor("Supplies").querySelectorAll("svg")).toHaveLength(1);
    harness.dispose();
  });
});

describe("boolean values", () => {
  it("reads yes as a positive check and no as a muted dash, without a pill", () => {
    render(
      <>
        <BooleanValue value />
        <BooleanValue value={false} />
      </>,
    );
    const yes = screen.getByText("Yes").parentElement;
    const no = screen.getByText("No").parentElement;
    expect(yes).toHaveClass("text-positive");
    expect(yes?.querySelector("svg")).not.toBeNull();
    expect(no).toHaveClass("text-muted-foreground");
    expect(no?.querySelector("svg")).not.toBeNull();
    expect(document.querySelector("[data-enum-role]")).toBeNull();
  });
});

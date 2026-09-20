import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FilterableCombobox } from "./combobox";

const ITEMS = [
  {
    value: "food",
    label: "Food",
    color: "rgb(1, 2, 3)",
    icon: <span data-testid="food-icon">food glyph</span>,
  },
  { value: "materials", label: "Materials", color: "rgb(4, 5, 6)" },
];

function openCombobox() {
  const input = screen.getByRole("combobox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  return input;
}

describe("FilterableCombobox enum marks", () => {
  it("uses exactly one icon for icon-backed options", () => {
    render(
      <FilterableCombobox
        items={ITEMS}
        value={null}
        onValueChange={vi.fn()}
        placeholder="Choose category"
      />,
    );

    openCombobox();
    const option = screen.getByRole("option", { name: "Food" });
    expect(within(option).getAllByTestId("food-icon")).toHaveLength(1);
    expect(option.querySelectorAll("[data-enum-option-swatch]")).toHaveLength(
      0,
    );
  });

  it("uses exactly one swatch for color-only options", () => {
    render(
      <FilterableCombobox
        items={ITEMS}
        value={null}
        onValueChange={vi.fn()}
        placeholder="Choose category"
      />,
    );

    openCombobox();
    const option = screen.getByRole("option", { name: "Materials" });
    expect(within(option).queryAllByTestId("food-icon")).toHaveLength(0);
    expect(option.querySelectorAll("[data-enum-option-swatch]")).toHaveLength(
      1,
    );
  });
});

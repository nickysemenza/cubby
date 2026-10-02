import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { StaticPicker } from "./static-picker";

const ITEMS = [
  { value: "materials", label: "Materials", color: "rgb(1, 2, 3)" },
  { value: "services", label: "Services" },
  {
    value: "food",
    label: "Food",
    icon: <span data-testid="food-icon">food glyph</span>,
  },
];

function Harness() {
  const [value, setValue] = useState<string | null>("materials");
  return (
    <StaticPicker
      items={ITEMS}
      value={value}
      onValueChange={setValue}
      label="cost type"
    />
  );
}

describe("StaticPicker", () => {
  it("filters and writes the selected string value", () => {
    const onValueChange = vi.fn();
    render(
      <StaticPicker
        items={ITEMS}
        value={null}
        onValueChange={onValueChange}
        label="cost type"
      />,
    );

    const input = screen.getByRole("combobox", { name: "cost type" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "serv" } });
    expect(screen.queryByRole("option", { name: "Materials" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Services" }));
    expect(onValueChange).toHaveBeenCalledWith("services");
  });

  it("renders a color-only option with one categorical swatch", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "cost type" });
    expect(input).toHaveValue("Materials");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = screen.getByRole("option", { name: "Materials" });
    expect(within(option).queryAllByTestId("food-icon")).toHaveLength(0);
    expect(option.querySelectorAll('[style*="background-color"]')).toHaveLength(
      1,
    );
  });

  it("renders an icon-backed option with one icon and no categorical swatch", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "cost type" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = screen.getByRole("option", { name: "Food" });
    expect(within(option).getAllByTestId("food-icon")).toHaveLength(1);
    expect(option.querySelectorAll('[style*="background-color"]')).toHaveLength(
      0,
    );
  });
});

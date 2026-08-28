import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { StaticPicker } from "./static-picker";

const ITEMS = [
  { value: "materials", label: "Materials", color: "rgb(1, 2, 3)" },
  { value: "services", label: "Services" },
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

  it("renders the selected label and categorical swatch", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "cost type" });
    expect(input).toHaveValue("Materials");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      document.querySelector('[style*="background-color"]'),
    ).not.toBeNull();
  });
});

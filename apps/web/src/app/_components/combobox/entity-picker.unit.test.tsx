import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ComboboxItem } from "./combobox-types";
import { EntityPicker, matchesPickerItem } from "./entity-picker";

const ITEMS: ComboboxItem[] = [
  {
    id: "product-uuid",
    shortcode: "PRD-2ABC",
    name: "Cordless Drill",
    aliases: ["driver"],
    secondary: "Makita",
  },
  {
    id: "saw-uuid",
    shortcode: "PRD-3ABC",
    name: "Track Saw",
    secondary: "Festool",
  },
];

function Harness({ clearable = false }: { clearable?: boolean }) {
  const [value, setValue] = useState<ComboboxItem | null>(ITEMS[0] ?? null);
  return (
    <EntityPicker
      entity="product"
      label="product"
      items={ITEMS}
      value={value}
      setValue={setValue}
      clearable={clearable}
    />
  );
}

function openPicker(input: HTMLElement) {
  input.focus();
  fireEvent.keyDown(input, { key: "ArrowDown" });
}

describe("matchesPickerItem", () => {
  it.each(["cordless", "driver", "makita", "prd-2abc"])(
    "searches names, aliases, metadata, and full shortcodes: %s",
    (query) => {
      expect(matchesPickerItem(ITEMS[0]!, query)).toBe(true);
    },
  );
});

describe("EntityPicker", () => {
  it("uses one direct-focus input and renders the selected item as a checked result", async () => {
    render(<Harness />);
    expect(screen.getByText("PRD")).toBeInTheDocument();

    const input = screen.getByRole("combobox", { name: "product" });
    openPicker(input);
    await waitFor(() => expect(input).toHaveFocus());

    const popup = document.querySelector("[data-combobox-popup]");
    expect(popup).toBeInstanceOf(HTMLElement);
    expect(within(popup as HTMLElement).getByText("PRD-2ABC")).toBeVisible();
    expect(
      within(popup as HTMLElement).getByRole("option", {
        name: /Cordless Drill Makita PRD-2ABC/,
      }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("clears only through the explicit clear control", async () => {
    render(<Harness clearable />);
    fireEvent.click(screen.getByRole("button", { name: "Clear product" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "product" })).toHaveValue(""),
    );
  });

  it("offers creation without an exact name match and suppresses it for exact names", () => {
    const create = vi.fn(async (name: string) => ({ id: name, name }));
    render(
      <EntityPicker
        entity="product"
        label="product"
        items={ITEMS}
        value={null}
        setValue={vi.fn()}
        onCreateNew={create}
      />,
    );
    const input = screen.getByRole("combobox", { name: "product" });
    openPicker(input);
    fireEvent.change(input, { target: { value: "Cordless" } });
    expect(
      screen.getByRole("button", { name: "Create product: Cordless" }),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "CORDLESS DRILL" } });
    expect(
      screen.queryByRole("button", { name: /Create product/ }),
    ).not.toBeInTheDocument();
  });

  it("closes the picker before starting creation and selects the created item", async () => {
    let popupWasOpenWhenCreateStarted = true;
    const setValue = vi.fn();
    const create = vi.fn(async (name: string) => {
      popupWasOpenWhenCreateStarted =
        document.querySelector("[data-combobox-popup]") != null;
      return { id: "created-product", name };
    });
    render(
      <EntityPicker
        entity="product"
        label="product"
        items={ITEMS}
        value={null}
        setValue={setValue}
        onCreateNew={create}
      />,
    );

    const input = screen.getByRole("combobox", { name: "product" });
    openPicker(input);
    fireEvent.change(input, { target: { value: "New Drill" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Create product: New Drill" }),
    );

    await waitFor(() => expect(create).toHaveBeenCalledWith("New Drill"));
    expect(popupWasOpenWhenCreateStarted).toBe(false);
    await waitFor(() =>
      expect(setValue).toHaveBeenCalledWith({
        id: "created-product",
        name: "New Drill",
      }),
    );
  });

  it("shows wrong-prefix shortcodes as not found and never offers creation", () => {
    render(
      <EntityPicker
        entity="product"
        label="product"
        items={ITEMS}
        value={null}
        setValue={vi.fn()}
        onCreateNew={vi.fn(async (name) => ({ id: name, name }))}
      />,
    );
    const input = screen.getByRole("combobox", { name: "product" });
    openPicker(input);
    fireEvent.change(input, { target: { value: "loc-2abc" } });
    expect(screen.getByText("LOC-2ABC is not a PRD code.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create product/ }),
    ).not.toBeInTheDocument();
  });
});

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

function PlantingHarness() {
  const [value, setValue] = useState<ComboboxItem | null>({
    id: "PLT-4K7M",
    shortcode: "PLT-4K7M",
    name: "Example crop · current",
  });
  return (
    <EntityPicker
      entity="planting"
      label="Planting"
      items={[
        {
          id: "PLT-8K7M",
          shortcode: "PLT-8K7M",
          name: "Example crop · replacement",
        },
      ]}
      value={value}
      setValue={setValue}
      clearable
    />
  );
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
  it("sizes an intrinsic picker to its options while retaining the trigger minimum", () => {
    render(
      <EntityPicker
        label="cost type"
        items={[
          { id: "short", name: "Materials" },
          { id: "long", name: "Services and recurring maintenance" },
        ]}
        value={null}
        setValue={vi.fn()}
        widthMode="intrinsic"
      />,
    );

    openPicker(screen.getByRole("combobox", { name: "cost type" }));
    const popup = screen.getByRole("listbox").parentElement;
    expect(popup).toHaveClass("w-max");
    expect(popup).toHaveClass("min-w-[var(--anchor-width)]");
    expect(popup).toHaveClass(
      "max-w-[min(24rem,var(--available-width),calc(100vw-16px))]",
    );
  });

  it("selects a replacement planting and can clear it", async () => {
    render(<PlantingHarness />);
    const input = screen.getByRole("combobox", { name: "Planting" });
    expect(input).toHaveValue("Example crop · current");
    openPicker(input);
    fireEvent.click(
      screen.getByRole("option", { name: /Example crop · replacement/ }),
    );
    await waitFor(() =>
      expect(input).toHaveValue("Example crop · replacement"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear Planting" }));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("uses one direct-focus input and renders the selected item as a checked result", async () => {
    render(<Harness />);
    expect(screen.queryByText("PRD")).not.toBeInTheDocument();

    const input = screen.getByRole("combobox", { name: "product" });
    openPicker(input);
    await waitFor(() => expect(input).toHaveFocus());

    const popup = document.querySelector("[data-combobox-popup]");
    expect(popup).toBeInstanceOf(HTMLElement);
    if (!(popup instanceof HTMLElement)) return;
    expect(within(popup).queryByText("PRD-2ABC")).not.toBeInTheDocument();
    expect(
      within(popup).getByRole("option", {
        name: /Cordless Drill Makita PRD-2ABC/,
      }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("derives the placeholder from the entity noun, not a sentence-length caption", () => {
    render(
      <EntityPicker
        entity="location"
        label="Use an existing location (optional)"
        items={[]}
        value={null}
        setValue={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "Use an existing location (optional)",
    });
    expect(input).toHaveAttribute("placeholder", "Choose a location…");
  });

  it("falls back to a generic placeholder with no entity key", () => {
    render(
      <EntityPicker label="About" items={[]} value={null} setValue={vi.fn()} />,
    );
    expect(screen.getByRole("combobox", { name: "About" })).toHaveAttribute(
      "placeholder",
      "Choose…",
    );
  });

  it("lets an explicit placeholder override the entity-derived default", () => {
    render(
      <EntityPicker
        entity="location"
        label="Use an existing location (optional)"
        placeholder="Pick a spot…"
        items={[]}
        value={null}
        setValue={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("combobox", {
        name: "Use an existing location (optional)",
      }),
    ).toHaveAttribute("placeholder", "Pick a spot…");
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

  it.each(["H-E-B", "Co-op", "A-1", "Q-tips"])(
    "offers creation for a hyphenated name: %s",
    (name) => {
      render(
        <EntityPicker
          entity="vendor"
          label="vendor"
          items={[]}
          value={null}
          setValue={vi.fn()}
          onCreateNew={vi.fn(async (createdName) => ({
            id: createdName,
            name: createdName,
          }))}
        />,
      );
      const input = screen.getByRole("combobox", { name: "vendor" });
      openPicker(input);
      fireEvent.change(input, { target: { value: name } });
      expect(
        screen.getByRole("button", { name: `Create vendor: ${name}` }),
      ).toBeInTheDocument();
    },
  );

  it("does not offer creation for a malformed code using the entity prefix", () => {
    render(
      <EntityPicker
        entity="vendor"
        label="vendor"
        items={[]}
        value={null}
        setValue={vi.fn()}
        onCreateNew={vi.fn(async (name) => ({ id: name, name }))}
      />,
    );
    const input = screen.getByRole("combobox", { name: "vendor" });
    openPicker(input);
    fireEvent.change(input, { target: { value: "VEN-not-a-code" } });
    expect(
      screen.queryByRole("button", { name: /Create vendor/ }),
    ).not.toBeInTheDocument();
  });

  it("renders ordered evidence groups and leaves invalid choices disabled", () => {
    const setValue = vi.fn();
    render(
      <EntityPicker
        entity="product"
        label="product"
        items={[
          {
            id: "returned",
            name: "Returned brace",
            presentation: {
              group: { id: "other", label: "Other products", order: 2 },
              status: { label: "Returned" },
              facts: ["0 on hand / 0 expected"],
            },
          },
          {
            id: "needed",
            name: "Needed brace",
            presentation: {
              group: {
                id: "needs-stock",
                label: "Needs stocking",
                order: 0,
              },
              status: { label: "Need 1", tone: "positive" },
              facts: ["0 on hand / 1 expected"],
            },
          },
          {
            id: "invalid",
            name: "Current product",
            presentation: {
              group: { id: "unavailable", label: "Unavailable", order: 99 },
              disabledReason: "Already selected",
            },
          },
        ]}
        value={null}
        setValue={setValue}
      />,
    );

    openPicker(screen.getByRole("combobox", { name: "product" }));
    const headers = screen.getAllByText(
      /Needs stocking|Other products|Unavailable/,
    );
    expect(headers.map((header) => header.textContent)).toEqual([
      "Needs stocking",
      "Other products",
      "Unavailable",
    ]);
    expect(screen.getByText("0 on hand / 1 expected")).toBeInTheDocument();
    const invalid = screen.getByRole("option", {
      name: /Current product Already selected/,
    });
    expect(invalid).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(invalid);
    expect(setValue).not.toHaveBeenCalled();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderUi,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactElement, type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { entityDetailFor } from "~/entity/entity-detail";

import type { ComboboxItem } from "./combobox-types";
import { matchesPickerItem, Picker } from "./picker";

// Record pickers read stored codes' records through React Query.
function render(ui: ReactElement, client = new QueryClient()) {
  return renderUi(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

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
    <Picker
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
    <Picker
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

describe("Picker records", () => {
  it("shows the selected record image before opening or searching", () => {
    const { container } = render(
      <Picker
        entity="location"
        label="Receive into"
        items={[
          {
            id: "LOC-4K7M",
            name: "Example shelf",
            thumb: { imageUrl: "/synthetic-shelf.jpg", fallback: null },
          },
        ]}
        value={{ id: "LOC-4K7M", name: "Example shelf" }}
        setValue={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-picker-visual] img")).toHaveAttribute(
      "src",
      expect.stringContaining("synthetic-shelf"),
    );
  });
  it("leads a record row with one mark: its picture, never a swatch beside it", () => {
    render(
      <Picker
        entity="product"
        label="product"
        items={[
          {
            id: "pictured",
            name: "Pictured Product",
            color: "rgb(1, 2, 3)",
            thumb: { imageUrl: "/synthetic-product.jpg", fallback: null },
          },
        ]}
        value={null}
        setValue={vi.fn()}
      />,
    );

    openPicker(screen.getByRole("combobox", { name: "product" }));
    const option = screen.getByRole("option", { name: "Pictured Product" });
    expect(option.querySelectorAll("[data-picker-visual] img")).toHaveLength(1);
    expect(option.querySelectorAll("[data-enum-option-swatch]")).toHaveLength(
      0,
    );
  });

  it("matches the popup to the field, growing a narrow field's popup to 16rem", () => {
    render(
      <Picker
        label="cost type"
        items={[
          { id: "short", name: "Materials" },
          { id: "long", name: "Services and recurring maintenance" },
        ]}
        value={null}
        setValue={vi.fn()}
      />,
    );

    openPicker(screen.getByRole("combobox", { name: "cost type" }));
    const popup = screen.getByRole("listbox").parentElement;
    expect(popup).toHaveClass("w-max");
    expect(popup).toHaveClass("min-w-(--anchor-width)");
    expect(popup).toHaveClass(
      "max-w-[min(max(var(--anchor-width),16rem),var(--available-width),calc(100vw-16px))]",
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
    const selected = within(popup).getByRole("option", {
      name: "Cordless Drill Makita",
    });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });

  it("derives the placeholder from the entity noun, not a sentence-length caption", () => {
    render(
      <Picker
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
    render(<Picker label="About" items={[]} value={null} setValue={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "About" })).toHaveAttribute(
      "placeholder",
      "Choose…",
    );
  });

  it("lets an explicit placeholder override the entity-derived default", () => {
    render(
      <Picker
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
      <Picker
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
      <Picker
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
      <Picker
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
        <Picker
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
      <Picker
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
      <Picker
        entity="product"
        label="product"
        items={[
          {
            id: "returned",
            name: "Returned brace",
            presentation: {
              group: { id: "other", label: "Other products", order: 2 },
              trailing: [
                { text: "Returned" },
                { text: "0 on hand / 0 expected" },
              ],
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
              trailing: [
                { text: "Need 1", tone: "positive" },
                { text: "0 on hand / 1 expected" },
              ],
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

const OPTIONS = [
  { value: "materials", label: "Materials", color: "rgb(1, 2, 3)" },
  { value: "services", label: "Services" },
  {
    value: "food",
    label: "Food",
    color: "rgb(4, 5, 6)",
    icon: <span data-testid="food-icon">food glyph</span>,
  },
];

function OptionHarness({
  initial,
  mode,
}: {
  initial: string | null;
  mode?: "search" | "choose";
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <Picker
      mode={mode}
      label="cost type"
      options={OPTIONS}
      value={value}
      onValueChange={setValue}
    />
  );
}

describe("Picker options", () => {
  it("filters and writes the selected string value", () => {
    const onValueChange = vi.fn();
    render(
      <Picker
        label="cost type"
        options={OPTIONS}
        value={null}
        onValueChange={onValueChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: "cost type" });
    openPicker(input);
    fireEvent.change(input, { target: { value: "serv" } });
    expect(screen.queryByRole("option", { name: "Materials" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Services" }));
    expect(onValueChange).toHaveBeenCalledWith("services");
  });

  it("marks a row with its tinted glyph or, without one, a single swatch", () => {
    render(<OptionHarness initial={null} />);
    openPicker(screen.getByRole("combobox", { name: "cost type" }));
    const food = screen.getByRole("option", { name: "Food" });
    expect(within(food).getAllByTestId("food-icon")).toHaveLength(1);
    expect(food.querySelectorAll("[data-enum-option-swatch]")).toHaveLength(0);
    const materials = screen.getByRole("option", { name: "Materials" });
    expect(
      materials.querySelectorAll("[data-enum-option-swatch]"),
    ).toHaveLength(1);
  });

  // Regression: the closed field showed only the label, dropping the glyph
  // every row carries.
  it("shows the selected option's glyph in the closed field", () => {
    const { container } = render(<OptionHarness initial="food" />);
    expect(screen.getByRole("combobox", { name: "cost type" })).toHaveValue(
      "Food",
    );
    const lead = container.querySelector("[data-picker-visual]");
    expect(lead).toBeInstanceOf(HTMLElement);
    expect(lead?.querySelector("[data-testid=food-icon]")).not.toBeNull();
  });

  it("chooses without a text input in choose mode", async () => {
    render(<OptionHarness initial="materials" mode="choose" />);
    const trigger = screen.getByRole("combobox", { name: "cost type" });
    expect(trigger.tagName).not.toBe("INPUT");
    expect(trigger).toHaveTextContent("Materials");
    // Keyboard, as with a native select: open, letter typeahead, Enter.
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("option", { name: "Food" });
    fireEvent.keyDown(document.activeElement ?? trigger, { key: "f" });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Food" })).toHaveAttribute(
        "data-highlighted",
      ),
    );
    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Enter" });
    await waitFor(() => expect(trigger).toHaveTextContent("Food"));
    expect(trigger.querySelector("[data-testid=food-icon]")).not.toBeNull();
  });
});

describe("Picker segmented and multiple", () => {
  it("shows every option inline in segmented mode and selects by press", () => {
    const onValueChange = vi.fn();
    render(
      <Picker
        mode="segmented"
        label="View"
        options={[
          { value: "list", label: "List" },
          { value: "board", label: "Board" },
        ]}
        value="list"
        onValueChange={onValueChange}
      />,
    );
    const group = screen.getByRole("group", { name: "View" });
    const board = within(group).getByRole("button", { name: "Board" });
    expect(within(group).getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(board);
    expect(onValueChange).toHaveBeenCalledWith("board");
  });

  it("keeps several values as removable chips and adds from the list", () => {
    const onValuesChange = vi.fn();
    render(
      <Picker
        multiple
        label="cost types"
        options={OPTIONS}
        values={["materials"]}
        onValuesChange={onValuesChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Materials" }));
    expect(onValuesChange).toHaveBeenLastCalledWith([]);
    openPicker(screen.getByRole("combobox", { name: "cost types" }));
    fireEvent.click(screen.getByRole("option", { name: "Services" }));
    expect(onValuesChange).toHaveBeenLastCalledWith(["materials", "services"]);
  });

  it("shows a row's trailing chips and announces them", () => {
    render(
      <Picker
        label="sheet"
        options={[{ value: "maple", label: "Maple", hint: "$47/sheet" }]}
        value={null}
        onValueChange={vi.fn()}
      />,
    );
    openPicker(screen.getByRole("combobox", { name: "sheet" }));
    const row = screen.getByRole("option", { name: "Maple $47/sheet" });
    expect(within(row).getByText("$47/sheet")).toBeInTheDocument();
  });
});

describe("Picker stored codes", () => {
  const CODE = "PRD-4K7M";

  // Regression: a closed edit form showed the stored shortcode until the
  // deferred candidate list loaded.
  it("shows the record's name and picture, never its code", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // SAFETY: the picker's product builder reads only these detail fields;
    // the rest of the detail shape is irrelevant to the closed field.
    const detail = {
      id: CODE,
      name: "Rolled Oats",
      manufacturer: "Harvest Mill",
      coverImageUrl: "https://images.example.test/oats.jpg",
    } as never;
    client.setQueryData(
      entityDetailFor("product").queryOptions(CODE).queryKey,
      detail,
    );
    const { container } = render(
      <Picker
        entity="product"
        label="product"
        items={[]}
        value={{ id: CODE, name: CODE }}
        setValue={vi.fn()}
      />,
      client,
    );
    const input = screen.getByRole("combobox", { name: "product" });
    expect(input).toHaveValue("Rolled Oats");
    expect(container.querySelector("[data-picker-visual] img")).not.toBeNull();
    expect(container).not.toHaveTextContent(CODE);
  });

  // Regression: a detail read answers null for a deleted record, and the
  // builder threw during render.
  it("names a missing record instead of throwing", () => {
    const client = new QueryClient();
    client.setQueryData(
      entityDetailFor("product").queryOptions(CODE).queryKey,
      null,
    );
    const { container } = render(
      <Picker
        entity="product"
        label="product"
        items={[]}
        value={{ id: CODE, name: CODE }}
        setValue={vi.fn()}
      />,
      client,
    );
    expect(screen.getByRole("combobox", { name: "product" })).toHaveValue(
      "Missing product",
    );
    expect(container).not.toHaveTextContent(CODE);
  });

  // Regression: a string option list built from records (cookbooks) showed
  // the stored code until its roster loaded.
  it("waits for a loading option roster instead of showing a stored code", () => {
    const { rerender, container } = render(
      <Picker
        mode="choose"
        label="cookbook"
        options={[]}
        isLoading
        value="CKB-4K7M"
        onValueChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "cookbook" });
    expect(trigger).toHaveTextContent("Loading…");
    rerender(
      <Picker
        mode="choose"
        label="cookbook"
        options={[]}
        value="CKB-4K7M"
        onValueChange={vi.fn()}
      />,
    );
    expect(trigger).toHaveTextContent("Unavailable record");
    expect(container).not.toHaveTextContent("CKB-4K7M");
  });

  it("shows a record's picture in its popup row", () => {
    render(
      <Picker
        label="first product"
        items={[
          {
            id: "PRD-2ABC",
            name: "Rolled Oats",
            thumb: {
              imageUrl: "https://images.example.test/oats.jpg",
              fallback: null,
            },
          },
        ]}
        value={null}
        setValue={vi.fn()}
      />,
    );
    openPicker(screen.getByRole("combobox", { name: "first product" }));
    const row = screen.getByRole("option", { name: "Rolled Oats" });
    expect(row.querySelector("[data-picker-visual] img")).not.toBeNull();
  });

  it("shows a loading state rather than the code while the record loads", () => {
    const { container } = render(
      <Picker
        entity="product"
        label="product"
        items={[]}
        value={{ id: CODE, name: CODE }}
        setValue={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "product" });
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Loading…");
    expect(container).not.toHaveTextContent(CODE);
  });
});

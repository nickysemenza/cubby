import type { Amount } from "@cubby/schemas/codec";
import type {
  InventoryShortcode,
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import {
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { ComboboxItem } from "../combobox/combobox-types";
import type { SearchProviderProps } from "../combobox/with-search-hook";
import { InventoryEntriesCell } from "./inventory-entries-cell";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function render(element: ReactElement) {
  return renderWithTestingLibrary(element, { wrapper: harness.wrapper });
}

const PANTRY: ComboboxItem<LocationShortcode> = {
  id: testShortcode("location", "loc-1"),
  name: "Pantry (shelf)",
};
const FRIDGE: ComboboxItem<LocationShortcode> = {
  id: testShortcode("location", "loc-2"),
  name: "Fridge (shelf)",
};
const STATIC_ITEMS: ComboboxItem<LocationShortcode>[] = [PANTRY, FRIDGE];

/** Stub SearchProvider — bypasses the real query hooks and hands back a
 * static item list synchronously, matching editable-entity-cell.unit.test.tsx. */
function StubSearchProvider({
  children,
}: SearchProviderProps<LocationShortcode>) {
  return children({
    items: STATIC_ITEMS,
    onSearchChange: vi.fn(),
    isLoading: false,
    onOpenChange: vi.fn(),
  });
}

interface TestEntry {
  id: InventoryShortcode;
  amount: Amount;
  location?: { id: LocationShortcode; name: string; type: LocationType | null };
}

interface ProductEntry {
  id: InventoryShortcode;
  amount: Amount;
  product?: { id: ProductShortcode; name: string; manufacturer: string };
}

interface TestRow {
  id: ProductShortcode;
  name: string;
}

const ROW: TestRow = {
  id: testShortcode("product", "PRD-2345"),
  name: "Flour",
};

const getRelatedEntity = (entry: TestEntry) => entry.location;

const openEditor = () => {
  fireEvent.click(screen.getByRole("button", { name: "Edit location" }));
};

const openCombobox = () => {
  // The editor auto-opens the dropdown on mount (autoFocus). Only click to open
  // when it isn't already open — a click while open would toggle it shut.
  if (!document.querySelector("[data-combobox-popup]")) {
    fireEvent.click(screen.getByRole("combobox"));
  }
};

/** Click a row inside the portaled dropdown, scoped to the popup because the
 * display trigger stays mounted during editing (overlay model). Mirrors
 * editable-entity-cell.unit.test.tsx's clickDropdownItem helper. */
const clickDropdownItem = (name: string) => {
  const popup = document.querySelector("[data-combobox-popup]");
  if (!(popup instanceof HTMLElement)) throw new Error("dropdown not open");
  fireEvent.click(within(popup).getByRole("option", { name }));
};

describe("InventoryEntriesCell", () => {
  it("renders the correlated product projection in stacked layout", () => {
    const product: ProductEntry["product"] = {
      id: testShortcode("product", "prd-1"),
      name: "Bread Flour",
      manufacturer: "Mill House",
    };
    const entry: ProductEntry = {
      id: testShortcode("inventory", "inv-product-1"),
      amount: { value: 1, unit: "bag" },
      product,
    };

    render(
      <InventoryEntriesCell<TestRow, ProductEntry, "product">
        entries={[entry]}
        entity="product"
        getRelatedEntity={(candidate) => candidate.product}
        layout="stacked"
        row={ROW}
      />,
    );

    expect(screen.getByText("1 bag")).toBeInTheDocument();
    expect(screen.getByText("Bread Flour")).toBeInTheDocument();
    expect(screen.getByText(/Mill House/)).toBeInTheDocument();
  });

  it("0 entries: shows NoneValue, and picking a location creates an entry", async () => {
    const onCreateEntry = vi.fn().mockResolvedValue(undefined);
    const onMoveEntry = vi.fn().mockResolvedValue(undefined);

    render(
      <InventoryEntriesCell<TestRow, TestEntry, "location">
        entries={[]}
        entity="location"
        getRelatedEntity={getRelatedEntity}
        layout="inline"
        row={ROW}
        inlineEdit={{
          SearchProvider: StubSearchProvider,
          onMoveEntry,
          onCreateEntry,
        }}
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    openEditor();
    openCombobox();
    // Commit-on-pick: choosing a location saves immediately, no ✓ confirm.
    clickDropdownItem("Fridge (shelf)");

    await waitFor(() => {
      expect(onCreateEntry).toHaveBeenCalledTimes(1);
    });
    expect(onCreateEntry).toHaveBeenCalledWith(ROW, FRIDGE.id);
    expect(onMoveEntry).not.toHaveBeenCalled();
  });

  it("1 entry: renders amount + location name, and moving saves the new location", async () => {
    const onMoveEntry = vi.fn().mockResolvedValue(undefined);
    const onCreateEntry = vi.fn().mockResolvedValue(undefined);
    const entry: TestEntry = {
      id: testShortcode("inventory", "inv-1"),
      amount: { value: 2, unit: "lb" },
      location: {
        id: testShortcode("location", "loc-1"),
        name: "Pantry",
        type: "shelf",
      },
    };

    render(
      <InventoryEntriesCell<TestRow, TestEntry, "location">
        entries={[entry]}
        entity="location"
        getRelatedEntity={getRelatedEntity}
        layout="inline"
        row={ROW}
        inlineEdit={{
          SearchProvider: StubSearchProvider,
          onMoveEntry,
          onCreateEntry,
        }}
      />,
    );

    expect(screen.getByText("2 lb")).toBeInTheDocument();
    expect(screen.getByText("Pantry")).toBeInTheDocument();

    openEditor();
    openCombobox();
    // Commit-on-pick: choosing a location saves immediately, no ✓ confirm.
    clickDropdownItem("Fridge (shelf)");

    await waitFor(() => {
      expect(onMoveEntry).toHaveBeenCalledTimes(1);
    });
    expect(onMoveEntry).toHaveBeenCalledWith(entry, FRIDGE.id);
    expect(onCreateEntry).not.toHaveBeenCalled();
  });

  it(">1 entries: quick-edit pencil calls onQuickEdit, no combobox is rendered", () => {
    const onQuickEdit = vi.fn();
    const onMoveEntry = vi.fn().mockResolvedValue(undefined);
    const onCreateEntry = vi.fn().mockResolvedValue(undefined);
    const entries: TestEntry[] = [
      {
        id: testShortcode("inventory", "inv-1"),
        amount: { value: 2, unit: "lb" },
        location: {
          id: testShortcode("location", "loc-1"),
          name: "Pantry",
          type: "shelf",
        },
      },
      {
        id: testShortcode("inventory", "inv-2"),
        amount: { value: 1, unit: "lb" },
        location: {
          id: testShortcode("location", "loc-2"),
          name: "Fridge",
          type: "shelf",
        },
      },
    ];

    render(
      <InventoryEntriesCell<TestRow, TestEntry, "location">
        entries={entries}
        entity="location"
        getRelatedEntity={getRelatedEntity}
        layout="inline"
        row={ROW}
        onQuickEdit={onQuickEdit}
        inlineEdit={{
          SearchProvider: StubSearchProvider,
          onMoveEntry,
          onCreateEntry,
        }}
      />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit location" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quick edit" }));
    expect(onQuickEdit).toHaveBeenCalledTimes(1);
    expect(onQuickEdit).toHaveBeenCalledWith(ROW);
    expect(onMoveEntry).not.toHaveBeenCalled();
    expect(onCreateEntry).not.toHaveBeenCalled();
  });
});

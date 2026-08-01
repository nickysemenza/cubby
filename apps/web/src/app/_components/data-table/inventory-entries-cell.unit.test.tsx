import type { Amount } from "@cubby/schemas/codec";
import {
  type InventoryShortcode,
  type LocationShortcode,
  type ProductShortcode,
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Mock WASM module - can't load binary in jsdom. inventory-entries-cell.tsx
// (via tryFormatAmount / editable-entity-cell's editable-cell import) pulls in
// the whole ~/lib/wasm module graph even though no test here exercises it.
vi.mock("~/lib/wasm", () => ({
  wasm: {
    format_amount: (amt: { value: number; unit: string }) =>
      `${amt.value} ${amt.unit}`,
    is_valid_unit: () => true,
    amount_kind: () => "volume",
  },
}));

// Mock sonner toast (EditableEntityCell/EditableEntityEditor toast on error).
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

// EntityInlineLink → EntityPreviewLink renders a router `Link`, which needs a
// RouterProvider we don't have in a unit test. Stub it to a plain anchor —
// the 1-entry test only checks the location name renders, not navigation.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => (
    <a href="/test" className={className}>
      {children}
    </a>
  ),
}));

import type { ComboboxItem } from "../combobox/combobox-types";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import { InventoryEntriesCell } from "./inventory-entries-cell";

const PANTRY: ComboboxItem<LocationShortcode> = {
  id: unsafeLocationShortcode("loc-1"),
  name: "Pantry (shelf)",
};
const FRIDGE: ComboboxItem<LocationShortcode> = {
  id: unsafeLocationShortcode("loc-2"),
  name: "Fridge (shelf)",
};
const STATIC_ITEMS: ComboboxItem<LocationShortcode>[] = [PANTRY, FRIDGE];

/** Stub SearchProvider — bypasses the real query hooks and hands back a
 * static item list synchronously, matching editable-entity-cell.unit.test.tsx. */
function StubSearchProvider({
  children,
}: WithEntitySearchProps<LocationShortcode>) {
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
  location?: { id: LocationShortcode; name: string; type: LocationType };
}

interface TestRow {
  id: ProductShortcode;
  name: string;
}

const ROW: TestRow = {
  id: unsafeProductShortcode("PRD-2345"),
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
    expect(onCreateEntry).toHaveBeenCalledWith(ROW, "loc-2");
    expect(onMoveEntry).not.toHaveBeenCalled();
  });

  it("1 entry: renders amount + location name, and moving saves the new location", async () => {
    const onMoveEntry = vi.fn().mockResolvedValue(undefined);
    const onCreateEntry = vi.fn().mockResolvedValue(undefined);
    const entry: TestEntry = {
      id: unsafeInventoryShortcode("inv-1"),
      amount: { value: 2, unit: "lb" },
      location: {
        id: unsafeLocationShortcode("loc-1"),
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
    expect(onMoveEntry).toHaveBeenCalledWith(entry, "loc-2");
    expect(onCreateEntry).not.toHaveBeenCalled();
  });

  it(">1 entries: quick-edit pencil calls onQuickEdit, no combobox is rendered", () => {
    const onQuickEdit = vi.fn();
    const onMoveEntry = vi.fn().mockResolvedValue(undefined);
    const onCreateEntry = vi.fn().mockResolvedValue(undefined);
    const entries: TestEntry[] = [
      {
        id: unsafeInventoryShortcode("inv-1"),
        amount: { value: 2, unit: "lb" },
        location: {
          id: unsafeLocationShortcode("loc-1"),
          name: "Pantry",
          type: "shelf",
        },
      },
      {
        id: unsafeInventoryShortcode("inv-2"),
        amount: { value: 1, unit: "lb" },
        location: {
          id: unsafeLocationShortcode("loc-2"),
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

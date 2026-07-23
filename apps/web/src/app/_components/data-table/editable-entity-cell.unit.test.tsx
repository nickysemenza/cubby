import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock WASM module - can't load binary in jsdom. editable-entity-cell.tsx
// imports `useOptimisticDisplayValue` from ./editable-cell, whose other
// exports transitively import ~/lib/wasm (via format-amount.tsx), so the
// whole module graph loads even though this component never calls wasm.
vi.mock("~/lib/wasm", () => ({
  wasm: {
    format_amount: (amt: { value: number; unit: string }) =>
      `${amt.value} ${amt.unit}`,
    is_valid_unit: () => true,
    amount_kind: () => "volume",
  },
}));

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import type { ComboboxItem } from "../combobox/combobox-types";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import { EditableEntityCell } from "./editable-entity-cell";

const PANTRY: ComboboxItem<string> = { id: "loc-1", name: "Pantry" };
const FRIDGE: ComboboxItem<string> = { id: "loc-2", name: "Fridge" };
const GARAGE: ComboboxItem<string> = { id: "loc-3", name: "Garage" };
const STATIC_ITEMS: ComboboxItem<string>[] = [PANTRY, FRIDGE, GARAGE];

/** Stub SearchProvider — bypasses the real query hooks and hands back a
 * static item list synchronously, as real=false loading state. */
function StubSearchProvider({ children }: WithEntitySearchProps<string>) {
  return children({
    items: STATIC_ITEMS,
    onSearchChange: vi.fn(),
    isLoading: false,
    onOpenChange: vi.fn(),
  });
}

const renderValue = (v: ComboboxItem<string> | null) => (
  <span data-testid="display">{v?.name ?? "None"}</span>
);

/** The Check/X action buttons are icon-only; find them by their lucide svg
 * class, matching the pattern used in editable-cell.unit.test.tsx. Only call
 * these once the combobox dropdown is closed — its rows also render a
 * (opacity-0) Check icon for the selected-state indicator. */
const getCheckButton = () =>
  screen
    .getAllByRole("button")
    .find((btn) => btn.querySelector("svg.lucide-check"));
const getCancelButton = () =>
  screen
    .getAllByRole("button")
    .find((btn) => btn.querySelector("svg.lucide-x"));

const enterEditMode = () => {
  fireEvent.click(screen.getByRole("button"));
};

const openCombobox = () => {
  // The editor auto-opens the dropdown on mount (autoFocus). Only click to open
  // when it isn't already open — a click while open would toggle it shut.
  if (!document.querySelector("[data-combobox-popup]")) {
    fireEvent.click(screen.getByRole("combobox"));
  }
};

/** Click a row inside the portaled dropdown. Scoped to the popup because the
 * display trigger stays mounted during editing (overlay model) and can match
 * the same accessible name. */
const clickDropdownItem = (name: string) => {
  const popup = document.querySelector("[data-combobox-popup]");
  if (!(popup instanceof HTMLElement)) throw new Error("dropdown not open");
  fireEvent.click(within(popup).getByRole("button", { name }));
};

describe("EditableEntityCell", () => {
  it("renders display mode by default and enters edit mode on click without propagating", () => {
    const parentClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test only
      <div onClick={parentClick}>
        <EditableEntityCell
          value={PANTRY}
          onSave={vi.fn()}
          SearchProvider={StubSearchProvider}
          label="location"
          renderValue={renderValue}
        />
      </div>,
    );

    expect(screen.getByTestId("display")).toHaveTextContent("Pantry");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    enterEditMode();

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("saves the newly selected item and shows it optimistically", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableEntityCell
        value={PANTRY}
        onSave={onSave}
        SearchProvider={StubSearchProvider}
        label="location"
        renderValue={renderValue}
      />,
    );

    enterEditMode();
    openCombobox();

    fireEvent.click(screen.getByRole("button", { name: "Fridge" }));

    const checkButton = getCheckButton();
    expect(checkButton).toBeDefined();
    fireEvent.click(checkButton as HTMLElement);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenCalledWith("loc-2");

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("display")).toHaveTextContent("Fridge");
  });

  it("does not save when the selection is unchanged, and exits edit mode", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableEntityCell
        value={PANTRY}
        onSave={onSave}
        SearchProvider={StubSearchProvider}
        label="location"
        renderValue={renderValue}
      />,
    );

    enterEditMode();

    const checkButton = getCheckButton();
    expect(checkButton).toBeDefined();
    fireEvent.click(checkButton as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("display")).toHaveTextContent("Pantry");
  });

  it("cancels via the X button without calling onSave", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableEntityCell
        value={PANTRY}
        onSave={onSave}
        SearchProvider={StubSearchProvider}
        label="location"
        renderValue={renderValue}
      />,
    );

    enterEditMode();
    openCombobox();
    fireEvent.click(screen.getByRole("button", { name: "Fridge" }));

    const cancelButton = getCancelButton();
    expect(cancelButton).toBeDefined();
    fireEvent.click(cancelButton as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
    // Cancel discards the pending selection — still shows the original value.
    expect(screen.getByTestId("display")).toHaveTextContent("Pantry");
  });

  it("clearable: toggling the selected item off and saving clears the value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableEntityCell
        value={PANTRY}
        onSave={onSave}
        SearchProvider={StubSearchProvider}
        label="location"
        clearable
        renderValue={renderValue}
      />,
    );

    enterEditMode();
    openCombobox();
    // Clicking the already-selected item toggles selection to null.
    clickDropdownItem("Pantry");

    const checkButton = getCheckButton();
    expect(checkButton).toBeDefined();
    fireEvent.click(checkButton as HTMLElement);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenCalledWith(null);

    await waitFor(() => {
      expect(screen.getByTestId("display")).toHaveTextContent("None");
    });
  });

  it("not clearable: toggling the selected item off and saving is a no-op cancel", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableEntityCell
        value={PANTRY}
        onSave={onSave}
        SearchProvider={StubSearchProvider}
        label="location"
        renderValue={renderValue}
      />,
    );

    enterEditMode();
    openCombobox();
    clickDropdownItem("Pantry");

    const checkButton = getCheckButton();
    expect(checkButton).toBeDefined();
    fireEvent.click(checkButton as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("display")).toHaveTextContent("Pantry");
  });

  it("shows a toast and stays in edit mode when onSave rejects", async () => {
    const { toast } = await import("sonner");
    const onSave = vi.fn().mockRejectedValue(new Error("Failed to save"));
    render(
      <EditableEntityCell
        value={PANTRY}
        onSave={onSave}
        SearchProvider={StubSearchProvider}
        label="location"
        renderValue={renderValue}
      />,
    );

    enterEditMode();
    openCombobox();
    fireEvent.click(screen.getByRole("button", { name: "Fridge" }));

    const checkButton = getCheckButton();
    expect(checkButton).toBeDefined();
    fireEvent.click(checkButton as HTMLElement);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to save");
    });
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("filterItems hides excluded items from the dropdown", () => {
    render(
      <EditableEntityCell
        value={null}
        onSave={vi.fn()}
        SearchProvider={StubSearchProvider}
        label="location"
        filterItems={(item) => item.id !== GARAGE.id}
        renderValue={renderValue}
      />,
    );

    enterEditMode();
    openCombobox();

    expect(screen.getByText("Pantry")).toBeInTheDocument();
    expect(screen.getByText("Fridge")).toBeInTheDocument();
    expect(screen.queryByText("Garage")).not.toBeInTheDocument();
  });
});

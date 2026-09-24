import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { MouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ComboboxItem } from "../combobox/combobox-types";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import {
  EditorNotificationContext,
  type EditorNotificationPort,
} from "./editable-cell";
import { EditableEntityCell } from "./editable-entity-cell";

const PANTRY: ComboboxItem<string> = { id: "loc-1", name: "Pantry" };
const FRIDGE: ComboboxItem<string> = { id: "loc-2", name: "Fridge" };
const GARAGE: ComboboxItem<string> = { id: "loc-3", name: "Garage" };
const STATIC_ITEMS: ComboboxItem<string>[] = [PANTRY, FRIDGE, GARAGE];

function createEditorNotifications(): EditorNotificationPort & {
  errors: string[];
} {
  const errors: string[] = [];
  return {
    errors,
    showError: (message) => errors.push(message),
  };
}

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

/** The ✗ cancel action is icon-only; find it by its accessible name. (Commit-on-pick removed the
 * ✓ confirm button — picking a row saves immediately.) */
const getCancelButton = () => {
  return screen.getByRole("button", { name: "Cancel editing" });
};

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
  fireEvent.click(within(popup).getByRole("option", { name }));
};

describe("EditableEntityCell", () => {
  it("keeps a linked value outside the separate pencil edit trigger", () => {
    const displayClick = vi.fn((event: MouseEvent) => {
      event.preventDefault();
    });
    render(
      <EditableEntityCell
        value={PANTRY}
        onSave={vi.fn()}
        SearchProvider={StubSearchProvider}
        label="location"
        trigger="pencil"
        renderValue={(value) => (
          <a href="/locations/LOC-TEST" onClick={displayClick}>
            {value?.name}
          </a>
        )}
      />,
    );

    const link = screen.getByRole("link", { name: "Pantry" });
    expect(link.closest("button")).toBeNull();
    fireEvent.click(link);
    expect(displayClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit location" }));
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders display mode by default and enters edit mode on click without propagating", () => {
    const parentClick = vi.fn();
    render(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- This fixture deliberately mirrors the interaction target for event propagation coverage.
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

  it("saves on pick (no ✓ confirm) and shows the new item optimistically", async () => {
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

    // Picking a row commits immediately — no separate Check button click.
    clickDropdownItem("Fridge");

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenCalledWith("loc-2");

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("display")).toHaveTextContent("Fridge");
  });

  it("cancels via the ✗ button without calling onSave", async () => {
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

    // The first Escape closes the modal combobox surface, exposing the cell
    // editor controls again. The explicit ✗ then cancels the editor.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    const cancelButton = getCancelButton();
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("display")).toHaveTextContent("Pantry");
  });

  it("clearable: the explicit clear control saves null immediately", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Clear location" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenCalledWith(null);

    await waitFor(() => {
      expect(screen.getByTestId("display")).toHaveTextContent("None");
    });
  });

  it("not clearable: has no clear control and reselecting is a no-op", async () => {
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

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("display")).toHaveTextContent("Pantry");
  });

  it("shows a toast and stays in edit mode when onSave rejects", async () => {
    const notifications = createEditorNotifications();
    const onSave = vi.fn().mockRejectedValue(new Error("Failed to save"));
    render(
      <EditorNotificationContext.Provider value={notifications}>
        <EditableEntityCell
          value={PANTRY}
          onSave={onSave}
          SearchProvider={StubSearchProvider}
          label="location"
          renderValue={renderValue}
        />
      </EditorNotificationContext.Provider>,
    );

    enterEditMode();
    openCombobox();
    clickDropdownItem("Fridge");

    await waitFor(() => {
      expect(notifications.errors).toEqual(["Failed to save"]);
    });
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("guards against a second pick while a save is in flight (commit-on-pick race)", async () => {
    // The dropdown closes synchronously on pick, before the awaited save
    // resolves — without the re-entrancy guard, reopening and picking again
    // would fire a concurrent onSave whose last-to-resolve wins.
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
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
    clickDropdownItem("Fridge");
    expect(onSave).toHaveBeenCalledTimes(1);

    // Second pick while the first save is pending: jsdom doesn't enforce the
    // pointer-events gate, so this exercises the hard ref guard in commit().
    openCombobox();
    const popup = document.querySelector("[data-combobox-popup]");
    if (popup instanceof HTMLElement) {
      fireEvent.click(within(popup).getByRole("option", { name: "Garage" }));
    }
    expect(onSave).toHaveBeenCalledTimes(1);

    resolveSave?.();
    await waitFor(() => {
      expect(screen.getByTestId("display")).toHaveTextContent("Fridge");
    });
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

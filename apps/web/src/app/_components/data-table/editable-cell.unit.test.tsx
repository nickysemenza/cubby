import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock WASM module - can't load binary in jsdom
vi.mock("~/lib/wasm", () => ({
  wasm: {
    format_amount: (amt: { value: number; unit: string }) =>
      `${amt.value} ${amt.unit}`,
    is_valid_unit: () => true,
    amount_kind: () => "volume",
  },
}));

import {
  CELL_EDIT_EVENT,
  CellSelectionContext,
} from "./cell-selection-context";
import { EditableCell, useEditableCell } from "./editable-cell";

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe("useEditableCell", () => {
  const defaultProps = {
    value: "test value",
    onSave: vi.fn().mockResolvedValue(undefined),
    parse: (s: string) => s,
    format: (v: string) => v,
  };

  it("starts in non-editing state", () => {
    const { result } = renderHook(() => useEditableCell(defaultProps));

    expect(result.current.isEditing).toBe(false);
    expect(result.current.inputValue).toBe("");
    expect(result.current.displayValue).toBe("test value");
    expect(result.current.isPending).toBe(false);
  });

  it("enters editing mode with current value", () => {
    const { result } = renderHook(() => useEditableCell(defaultProps));

    act(() => {
      result.current.startEditing();
    });

    expect(result.current.isEditing).toBe(true);
    expect(result.current.inputValue).toBe("test value");
  });

  it("cancels editing mode", () => {
    const { result } = renderHook(() => useEditableCell(defaultProps));

    act(() => {
      result.current.startEditing();
    });
    expect(result.current.isEditing).toBe(true);

    act(() => {
      result.current.cancel();
    });
    expect(result.current.isEditing).toBe(false);
  });

  it("saves value and sets optimistic update", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useEditableCell({ ...defaultProps, onSave }),
    );

    act(() => {
      result.current.startEditing();
      result.current.setInputValue("new value");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(onSave).toHaveBeenCalledWith("new value");
    expect(result.current.isEditing).toBe(false);
    expect(result.current.displayValue).toBe("new value"); // Optimistic update
  });

  it("skips save if value unchanged", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useEditableCell({ ...defaultProps, onSave }),
    );

    act(() => {
      result.current.startEditing();
      // Input value is already "test value" from startEditing
    });

    await act(async () => {
      await result.current.save();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.isEditing).toBe(false);
  });

  it("handles save error with toast", async () => {
    const { toast } = await import("sonner");
    const onSave = vi.fn().mockRejectedValue(new Error("Save failed"));
    const { result } = renderHook(() =>
      useEditableCell({ ...defaultProps, onSave }),
    );

    act(() => {
      result.current.startEditing();
      result.current.setInputValue("new value");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(toast.error).toHaveBeenCalledWith("Save failed");
    expect(result.current.isEditing).toBe(true); // Still editing after error
  });

  it("handles Enter key to save", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useEditableCell({ ...defaultProps, onSave }),
    );

    act(() => {
      result.current.startEditing();
      result.current.setInputValue("new value");
    });

    act(() => {
      result.current.handleKeyDown({
        key: "Enter",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("new value");
    });
  });

  it("handles Escape key to cancel", () => {
    const { result } = renderHook(() => useEditableCell(defaultProps));

    act(() => {
      result.current.startEditing();
    });
    expect(result.current.isEditing).toBe(true);

    act(() => {
      result.current.handleKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });

    expect(result.current.isEditing).toBe(false);
  });

  it("parses empty input as null", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useEditableCell({ ...defaultProps, value: "existing", onSave }),
    );

    act(() => {
      result.current.startEditing();
      result.current.setInputValue("   "); // Whitespace only
    });

    await act(async () => {
      await result.current.save();
    });

    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("clears optimistic value when real value catches up", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useEditableCell({ ...defaultProps, value }),
      { initialProps: { value: "old" } },
    );

    // Set optimistic value
    act(() => {
      result.current.setOptimisticValue("new");
    });
    expect(result.current.displayValue).toBe("new");

    // Simulate real value updating to match
    rerender({ value: "new" });

    // Optimistic value should clear, showing real value
    expect(result.current.displayValue).toBe("new");
  });

  it("handles null initial value", () => {
    const { result } = renderHook(() =>
      useEditableCell({ ...defaultProps, value: null }),
    );

    expect(result.current.displayValue).toBe(null);

    act(() => {
      result.current.startEditing();
    });

    expect(result.current.inputValue).toBe("");
  });
});

describe("useEditableCell with number parsing", () => {
  it("parses numeric input correctly", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useEditableCell({
        value: 10,
        onSave,
        parse: (s) => {
          const num = parseFloat(s);
          return Number.isNaN(num) ? null : num;
        },
        format: (v) => String(v),
      }),
    );

    act(() => {
      result.current.startEditing();
      result.current.setInputValue("42.5");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(onSave).toHaveBeenCalledWith(42.5);
  });

  it("returns null for invalid number", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useEditableCell({
        value: 10,
        onSave,
        parse: (s) => {
          const num = parseFloat(s);
          return Number.isNaN(num) ? null : num;
        },
        format: (v) => String(v),
      }),
    );

    act(() => {
      result.current.startEditing();
      result.current.setInputValue("not a number");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(onSave).toHaveBeenCalledWith(null);
  });
});

describe("EditableCell component", () => {
  it("renders display mode by default", () => {
    render(
      <EditableCell
        value="Test Value"
        onSave={vi.fn()}
        config={{ type: "text" }}
        renderValue={(v) => <span data-testid="display">{v}</span>}
      />,
    );

    expect(screen.getByTestId("display")).toHaveTextContent("Test Value");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("enters edit mode on click", async () => {
    render(
      <EditableCell
        value="Test Value"
        onSave={vi.fn()}
        config={{ type: "text" }}
        renderValue={(v) => <span>{v}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
  });

  it("renders currency type with $ prefix", async () => {
    render(
      <EditableCell
        value={10.5}
        onSave={vi.fn()}
        config={{ type: "currency" }}
        renderValue={(v) => <span>${v}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText("$")).toBeInTheDocument();
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    });
  });

  it("renders number type with step attribute", async () => {
    render(
      <EditableCell
        value={5}
        onSave={vi.fn()}
        config={{ type: "number", step: "0.5" }}
        renderValue={(v) => <span>{v}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      const input = screen.getByRole("spinbutton");
      expect(input).toHaveAttribute("step", "0.5");
    });
  });

  it("shows check and cancel buttons in edit mode", async () => {
    render(
      <EditableCell
        value="Test"
        onSave={vi.fn()}
        config={{ type: "text" }}
        renderValue={(v) => <span>{v}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      // Should have 3 buttons: check, cancel (plus the original that's now hidden)
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("saves on check button click", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableCell
        value="Old"
        onSave={onSave}
        config={{ type: "text" }}
        renderValue={(v) => <span>{v}</span>}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    // Change value
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "New" },
    });

    // Click save (check button)
    const buttons = screen.getAllByRole("button");
    const saveButton = buttons.find((btn) =>
      btn.querySelector("svg.lucide-check"),
    );
    if (saveButton) {
      fireEvent.click(saveButton);
    }

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("New");
    });
  });

  it("cancels on X button click", async () => {
    const onSave = vi.fn();
    render(
      <EditableCell
        value="Original"
        onSave={onSave}
        config={{ type: "text" }}
        renderValue={(v) => <span data-testid="display">{v}</span>}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    // Click cancel (X button)
    const buttons = screen.getAllByRole("button");
    const cancelButton = buttons.find((btn) =>
      btn.querySelector("svg.lucide-x"),
    );
    if (cancelButton) {
      fireEvent.click(cancelButton);
    }

    await waitFor(() => {
      expect(screen.getByTestId("display")).toHaveTextContent("Original");
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("stops event propagation on click", () => {
    const parentClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test only
      <div onClick={parentClick}>
        <EditableCell
          value="Test"
          onSave={vi.fn()}
          config={{ type: "text" }}
          renderValue={(v) => <span>{v}</span>}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button"));

    // Parent click should not be called due to stopPropagation
    expect(parentClick).not.toHaveBeenCalled();
  });
});

describe("EditableCell select editor (commit-on-pick)", () => {
  const OPTIONS = [
    { value: "a", label: "Apple" },
    { value: "b", label: "Banana" },
  ];

  const renderSelect = (value: string | null, onSave: () => Promise<void>) =>
    render(
      <EditableCell
        value={value}
        onSave={onSave}
        config={{ type: "select", options: OPTIONS }}
        renderValue={(v) => <span data-testid="display">{String(v)}</span>}
      />,
    );

  /** Enter edit mode, then open the combobox dropdown via its chevron trigger
   * (autoFocus only focuses the filter input; it doesn't auto-open). */
  const openDropdown = async () => {
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: /open/i }));
  };

  it("saves on pick and closes — no ✓ confirm step", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderSelect("a", onSave);

    await openDropdown();
    fireEvent.click(await screen.findByRole("option", { name: "Banana" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("b");
    });
    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("display")).toHaveTextContent("b");
  });

  it("picking the current value closes without saving", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderSelect("a", onSave);

    await openDropdown();
    fireEvent.click(await screen.findByRole("option", { name: "Apple" }));

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does NOT render a ✓ confirm button, but keeps the ✗ cancel button", async () => {
    renderSelect("a", vi.fn().mockResolvedValue(undefined));

    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("combobox");

    const buttons = screen.getAllByRole("button");
    expect(buttons.some((b) => b.querySelector("svg.lucide-check"))).toBe(
      false,
    );
    expect(buttons.some((b) => b.querySelector("svg.lucide-x"))).toBe(true);
  });

  it("shows a toast and stays open when onSave rejects", async () => {
    const { toast } = await import("sonner");
    const onSave = vi.fn().mockRejectedValue(new Error("Save failed"));
    renderSelect("a", onSave);

    await openDropdown();
    fireEvent.click(await screen.findByRole("option", { name: "Banana" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Save failed");
    });
    // Editor stays open (combobox still mounted) with the current value intact.
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByTestId("display")).toHaveTextContent("a");
  });
});

describe("overlay behavior", () => {
  it("renders the editor into document.body via portal while keeping the display trigger mounted in place", async () => {
    const { container } = render(
      <EditableCell
        value="Test Value"
        onSave={vi.fn()}
        config={{ type: "text" }}
        renderValue={(v) => <span>{v}</span>}
      />,
    );

    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);

    const input = await screen.findByRole("textbox");

    // The trigger stays exactly where it was rendered (it's the overlay's
    // positioning anchor); the editor is portaled straight onto body.
    expect(container.contains(trigger)).toBe(true);
    expect(container.contains(input)).toBe(false);
    expect(document.body.contains(input)).toBe(true);
  });

  it("cancels edit mode on Escape without calling onSave", async () => {
    const onSave = vi.fn();
    render(
      <EditableCell
        value="Test Value"
        onSave={onSave}
        config={{ type: "text" }}
        renderValue={(v) => <span>{v}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const input = await screen.findByRole("textbox");

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cancels on an outside mousedown, but not on a mousedown inside the editor overlay", async () => {
    render(
      <EditableCell
        value="Test Value"
        onSave={vi.fn()}
        config={{ type: "text" }}
        renderValue={(v) => <span>{v}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const input = await screen.findByRole("textbox");

    // Inside the overlay: stays open.
    fireEvent.mouseDown(input);
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    // Outside: closes it.
    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
  });

  it("does not cancel on a mousedown inside a [data-combobox-popup] element", async () => {
    render(
      <EditableCell
        value="Test Value"
        onSave={vi.fn()}
        config={{ type: "text" }}
        renderValue={(v) => <span>{v}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("textbox");

    // Simulates a combobox dropdown's own body-level portal — the overlay
    // treats it as "inside" even though it's DOM-siblings, not a descendant.
    const popup = document.createElement("div");
    popup.setAttribute("data-combobox-popup", "");
    document.body.appendChild(popup);

    fireEvent.mouseDown(popup);
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    popup.remove();
  });

  it("stops Enter inside the editor from reaching an ancestor's onKeyDown, while typing still works", async () => {
    const wrapperKeyDown = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test only
      <div onKeyDown={wrapperKeyDown}>
        <EditableCell
          value="Test Value"
          onSave={onSave}
          config={{ type: "text" }}
          renderValue={(v) => <span>{v}</span>}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button"));
    const input = await screen.findByRole("textbox");

    fireEvent.change(input, { target: { value: "New Value" } });
    expect(input).toHaveValue("New Value");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("New Value");
    });
    expect(wrapperKeyDown).not.toHaveBeenCalled();
  });
});

describe("EditableCell type-to-edit seeding", () => {
  // In cell-selection mode a CELL_EDIT_EVENT carrying `seedText` opens the
  // editor — see useCellSelection's printable-key branch, which dispatches it.
  function openWithEvent(trigger: HTMLElement, seedText?: string) {
    act(() => {
      trigger.dispatchEvent(
        new CustomEvent(CELL_EDIT_EVENT, {
          detail: seedText === undefined ? {} : { seedText },
        }),
      );
    });
  }

  it("seeds the text editor with the typed character, replacing the current value", async () => {
    render(
      <CellSelectionContext.Provider value={true}>
        <EditableCell
          value="hello"
          onSave={vi.fn()}
          config={{ type: "text" }}
          renderValue={(v) => <span>{v}</span>}
        />
      </CellSelectionContext.Provider>,
    );

    openWithEvent(screen.getByRole("button"), "z");

    const input = await screen.findByRole("textbox");
    // The seed REPLACES the current value (Google Sheets), not appends.
    expect(input).toHaveValue("z");
  });

  it("opens with the current value when there is no seed (Enter / double-click)", async () => {
    render(
      <CellSelectionContext.Provider value={true}>
        <EditableCell
          value="hello"
          onSave={vi.fn()}
          config={{ type: "text" }}
          renderValue={(v) => <span>{v}</span>}
        />
      </CellSelectionContext.Provider>,
    );

    openWithEvent(screen.getByRole("button"));

    const input = await screen.findByRole("textbox");
    expect(input).toHaveValue("hello");
  });
});

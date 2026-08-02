import {
  act,
  fireEvent,
  render,
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
import { EditableCell } from "./editable-cell";

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

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

  it("opens when a contextual host directs focus to the cell", async () => {
    render(
      <EditableCell
        value={null}
        onSave={vi.fn()}
        config={{ type: "number", step: "1", placeholder: "Unknown" }}
        renderValue={(v) => <span>{v ?? "Unknown"}</span>}
        autoOpen
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
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

  /** Enter edit mode; the shared picker auto-opens ready for selection. */
  const openDropdown = async () => {
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("option", { name: "Apple" });
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

    const buttons = screen.getAllByRole("button", { hidden: true });
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

describe("EditableCell rich display trigger", () => {
  it("renders a link beside the edit button instead of inside it", () => {
    render(
      <EditableCell
        value="linked"
        onSave={vi.fn()}
        config={{ type: "text" }}
        trigger="pencil"
        renderValue={(value) => <a href="/detail">{value}</a>}
      />,
    );

    const link = screen.getByRole("link", { name: "linked" });
    const editButton = screen.getByRole("button", { name: "Edit value" });
    expect(link.closest("button")).toBeNull();
    expect(editButton.contains(link)).toBe(false);
  });
});

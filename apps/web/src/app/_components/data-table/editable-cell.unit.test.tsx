import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CELL_EDIT_EVENT,
  CellSelectionContext,
} from "./cell-selection-context";
import {
  EditableCell,
  EditorNotificationContext,
  type EditorNotificationPort,
} from "./editable-cell";

function createEditorNotifications(): EditorNotificationPort & {
  errors: string[];
} {
  const errors: string[] = [];
  return {
    errors,
    showError: (message) => errors.push(message),
  };
}

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

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "New" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save value" }));

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

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));

    await waitFor(() => {
      expect(screen.getByTestId("display")).toHaveTextContent("Original");
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("stops event propagation on click", () => {
    const parentClick = vi.fn();
    render(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- This fixture deliberately mirrors the interaction target for event propagation coverage.
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

    expect(parentClick).not.toHaveBeenCalled();
  });
});

describe("EditableCell currency editor (clearable)", () => {
  // `clearable` lets a currency field with a fallback (Product.price reverting
  // to an Expense-derived price) be returned to null with one click, instead
  // of requiring "select all, delete, Save" — and its `label` names what
  // clearing lands on, since an emptied box and a value that happens to equal
  // the fallback look identical otherwise.
  it("saves null through the clear affordance when clearable, without touching the input", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableCell
        value={20}
        onSave={onSave}
        config={{
          type: "currency",
          clearable: { label: "Revert to $12.00 (derived)" },
        }}
        renderValue={(v) => <span data-testid="display">{String(v)}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const input = await screen.findByRole("spinbutton");
    // The clear button commits null directly — the input is left untouched.
    expect(input).toHaveValue(20);

    fireEvent.click(
      screen.getByRole("button", { name: "Revert to $12.00 (derived)" }),
    );

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(null);
    });
  });

  it("offers no clear affordance by default", async () => {
    render(
      <EditableCell
        value={20}
        onSave={vi.fn().mockResolvedValue(undefined)}
        config={{ type: "currency" }}
        renderValue={(v) => <span>{String(v)}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("spinbutton");

    expect(screen.queryByRole("button", { name: /revert|clear/i })).toBeNull();
  });

  it("offers no clear affordance when there is nothing to clear (value already null)", async () => {
    render(
      <EditableCell
        value={null}
        onSave={vi.fn().mockResolvedValue(undefined)}
        config={{
          type: "currency",
          clearable: { label: "Revert to $12.00 (derived)" },
        }}
        renderValue={(v) => <span>{String(v)}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("spinbutton");

    expect(screen.queryByRole("button", { name: /revert|clear/i })).toBeNull();
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

    expect(screen.queryByRole("button", { name: "Save value" })).toBeNull();
    expect(
      screen
        .getAllByRole("button", { hidden: true })
        .some(
          (button) => button.getAttribute("aria-label") === "Cancel editing",
        ),
    ).toBe(true);
  });

  it("saves null through the clear affordance when clearable", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableCell
        value="a"
        onSave={onSave}
        config={{ type: "select", options: OPTIONS, clearable: true }}
        renderValue={(v) => <span data-testid="display">{String(v)}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("combobox");
    fireEvent.click(
      screen.getByRole("button", { name: /Clear/i, hidden: true }),
    );

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(null);
    });
  });

  it("offers no clear affordance by default", async () => {
    renderSelect("a", vi.fn().mockResolvedValue(undefined));

    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("combobox");

    expect(
      screen.queryByRole("button", { name: /^Clear/i, hidden: true }),
    ).toBeNull();
  });

  it("shows a toast and stays open when onSave rejects", async () => {
    const notifications = createEditorNotifications();
    const onSave = vi.fn().mockRejectedValue(new Error("Save failed"));
    render(
      <EditorNotificationContext.Provider value={notifications}>
        <EditableCell
          value="a"
          onSave={onSave}
          config={{ type: "select", options: OPTIONS }}
          renderValue={(value) => <span data-testid="display">{value}</span>}
        />
      </EditorNotificationContext.Provider>,
    );

    await openDropdown();
    fireEvent.click(await screen.findByRole("option", { name: "Banana" }));

    await waitFor(() => {
      expect(notifications.errors).toEqual(["Save failed"]);
    });
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

    fireEvent.mouseDown(input);
    expect(screen.getByRole("textbox")).toBeInTheDocument();

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
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- This fixture deliberately mirrors the interaction target for event propagation coverage.
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

describe("EditableCell date editing", () => {
  it("seeds the date input from type-to-edit", async () => {
    render(
      <CellSelectionContext.Provider value={true}>
        <EditableCell
          value="2026-08-18"
          onSave={vi.fn()}
          config={{ type: "date" }}
          renderValue={(value) => <span>{value}</span>}
        />
      </CellSelectionContext.Provider>,
    );

    const trigger = screen.getByRole("button");
    act(() => {
      trigger.dispatchEvent(
        new CustomEvent(CELL_EDIT_EVENT, { detail: { seedText: "8" } }),
      );
    });

    expect(await screen.findByRole("textbox")).toHaveValue("8");
  });

  it("commits a typed date on Enter exactly once", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableCell
        value="2026-08-18"
        onSave={onSave}
        config={{ type: "date" }}
        renderValue={(value) => <span>{value}</span>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Aug 20, 2026" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith("2026-08-20");
    });
  });

  it("commits a valid date on outside blur", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <div>
        <EditableCell
          value="2026-08-18"
          onSave={onSave}
          config={{ type: "date" }}
          renderValue={(value) => <span>{value}</span>}
        />
        <button type="button">Outside</button>
      </div>,
    );

    fireEvent.click(screen.getAllByRole("button")[0]!);
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "8/20/2026" } });
    input.focus();
    const outside = screen.getByRole("button", { name: "Outside" });
    fireEvent.mouseDown(outside);
    outside.focus();

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("2026-08-20");
    });
  });

  it("keeps an invalid outside-blurred editor open until Escape", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <div>
        <EditableCell
          value="2026-08-18"
          onSave={onSave}
          config={{ type: "date" }}
          renderValue={(value) => <span>{value}</span>}
        />
        <button type="button">Outside</button>
      </div>,
    );

    fireEvent.click(screen.getAllByRole("button")[0]!);
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "February 30, 2026" } });
    input.focus();
    const outside = screen.getByRole("button", { name: "Outside" });
    fireEvent.mouseDown(outside);
    outside.focus();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("February 30, 2026");
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("closes an invalid date editor before another cell starts editing", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <div>
        <EditableCell
          value="2026-08-18"
          onSave={onSave}
          config={{ type: "date" }}
          renderValue={(value) => <span>{value}</span>}
        />
        <EditableCell
          value="2026-08-19"
          onSave={onSave}
          config={{ type: "date" }}
          renderValue={(value) => <span>{value}</span>}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: /2026-08-18/ }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "February 30, 2026" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    const secondTrigger = screen.getByRole("button", { name: /2026-08-19/ });
    fireEvent.mouseDown(secondTrigger);
    fireEvent.click(secondTrigger);

    await waitFor(() => {
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(screen.getByRole("textbox")).toHaveValue("Aug 19, 2026");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
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

describe("EditableCell across a cell-selection mode flip", () => {
  // RTable's cell-selection mode used to be gated on react-query's
  // `isPlaceholderData`, so the edit gesture flipped mid-fetch. That coupling is
  // gone (see `cellSelectionEnabled` in Table.tsx), but the flip is still
  // reachable — a table can be remounted into a different mode — and an open
  // editor must ride it out. Edit state is local to the cell and the overlay is
  // portaled to <body>, so nothing here may key or remount on the context.
  it("keeps an open editor and its typed draft when the mode flips", async () => {
    const cell = (
      <EditableCell
        value="original"
        onSave={vi.fn()}
        config={{ type: "text" }}
        renderValue={(value) => <span>{value}</span>}
      />
    );
    const { rerender } = render(
      <CellSelectionContext.Provider value={false}>
        {cell}
      </CellSelectionContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "half-typed" },
    });

    rerender(
      <CellSelectionContext.Provider value={true}>
        {cell}
      </CellSelectionContext.Provider>,
    );

    expect(screen.getByRole("textbox")).toHaveValue("half-typed");
  });
});

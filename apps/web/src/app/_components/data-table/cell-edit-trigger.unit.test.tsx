import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchClipboardEvent,
  makeClipboardData,
} from "./cell-clipboard-test-helpers";
import { CellEditTrigger } from "./cell-edit-trigger";
import {
  CELL_EDIT_EVENT,
  CellSelectionContext,
} from "./cell-selection-context";

function dispatchCopy() {
  return dispatchClipboardEvent("copy", makeClipboardData());
}

describe("CellEditTrigger clipboard registration", () => {
  it("registers with the legacy clipboard registry outside cell-selection mode", () => {
    const getCopyPayload = vi.fn(() => ({ text: "x", json: "x" }));
    const { getByRole, unmount } = render(
      <CellEditTrigger
        onStartEdit={() => {}}
        clipboard={{ kindKey: "text", getCopyPayload }}
      >
        cell
      </CellEditTrigger>,
    );

    getByRole("button").focus();
    const event = dispatchCopy();
    expect(getCopyPayload).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    unmount();
  });

  it("does NOT register inside cell-selection mode — the range engine owns copy/paste", () => {
    // Regression (PR #412 review): with the trigger focused by a selection
    // click, a registered legacy paste listener runs BEFORE the range paste
    // listener and applies the raw TSV blob to the anchor cell (numeric
    // columns digit-strip it). Gating registration on the context prevents
    // the legacy handler from ever seeing in-table cells.
    const getCopyPayload = vi.fn(() => ({ text: "x", json: "x" }));
    const { getByRole, unmount } = render(
      <CellSelectionContext.Provider value={true}>
        <CellEditTrigger
          onStartEdit={() => {}}
          clipboard={{ kindKey: "text", getCopyPayload }}
        >
          cell
        </CellEditTrigger>
      </CellSelectionContext.Provider>,
    );

    getByRole("button").focus();
    const event = dispatchCopy();
    expect(getCopyPayload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    unmount();
  });
});

describe("CellEditTrigger click model", () => {
  it("outside cell-selection mode: single click starts editing", () => {
    const onStartEdit = vi.fn();
    const { getByRole, unmount } = render(
      <CellEditTrigger onStartEdit={onStartEdit}>cell</CellEditTrigger>,
    );
    fireEvent.click(getByRole("button"));
    expect(onStartEdit).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("inside cell-selection mode: click only selects; double-click and CELL_EDIT_EVENT edit", () => {
    const onStartEdit = vi.fn();
    const { getByRole, unmount } = render(
      <CellSelectionContext.Provider value={true}>
        <CellEditTrigger onStartEdit={onStartEdit}>cell</CellEditTrigger>
      </CellSelectionContext.Provider>,
    );
    const button = getByRole("button");

    fireEvent.click(button);
    expect(onStartEdit).not.toHaveBeenCalled();

    fireEvent.doubleClick(button);
    expect(onStartEdit).toHaveBeenCalledTimes(1);

    button.dispatchEvent(new CustomEvent(CELL_EDIT_EVENT));
    expect(onStartEdit).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("threads CELL_EDIT_EVENT detail.seedText into onStartEdit (type-to-edit)", () => {
    const onStartEdit = vi.fn();
    const { getByRole, unmount } = render(
      <CellSelectionContext.Provider value={true}>
        <CellEditTrigger onStartEdit={onStartEdit}>cell</CellEditTrigger>
      </CellSelectionContext.Provider>,
    );

    getByRole("button").dispatchEvent(
      new CustomEvent(CELL_EDIT_EVENT, { detail: { seedText: "k" } }),
    );
    expect(onStartEdit).toHaveBeenCalledWith("k");

    // A seedless event (Enter / double-click) opens with no seed.
    getByRole("button").dispatchEvent(new CustomEvent(CELL_EDIT_EVENT));
    expect(onStartEdit).toHaveBeenLastCalledWith(undefined);
    unmount();
  });
});

/**
 * In cell-selection mode a click on a cell only selects it — edit opens on
 * double-click or Enter, the spreadsheet contract. A pencil-shaped trigger is
 * the exception: the glyph's whole meaning is "click me to edit", and making
 * it need a second gesture it never advertised is a signifier that lies.
 */
function renderInSelectionMode(node: React.ReactNode) {
  return render(
    <CellSelectionContext.Provider value={true}>
      {node}
    </CellSelectionContext.Provider>,
  );
}

describe("CellEditTrigger in cell-selection mode", () => {
  it("edits on a single click when the trigger is the pencil", () => {
    const onStartEdit = vi.fn();
    renderInSelectionMode(
      <CellEditTrigger onStartEdit={onStartEdit} editOnClick aria-label="Edit">
        <span>pencil</span>
      </CellEditTrigger>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it("still only selects when the whole cell is the trigger", () => {
    const onStartEdit = vi.fn();
    renderInSelectionMode(
      <CellEditTrigger onStartEdit={onStartEdit} aria-label="Cell">
        <span>value</span>
      </CellEditTrigger>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cell" }));
    expect(onStartEdit).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByRole("button", { name: "Cell" }));
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });
});

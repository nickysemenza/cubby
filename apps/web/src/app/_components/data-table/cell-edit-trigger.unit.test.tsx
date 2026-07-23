import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CellEditTrigger } from "./cell-edit-trigger";
import {
  CELL_EDIT_EVENT,
  CellSelectionContext,
} from "./cell-selection-context";

function makeClipboardData() {
  return { setData: vi.fn(), getData: vi.fn(() => "") };
}

function dispatchCopy() {
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: makeClipboardData(),
    configurable: true,
  });
  document.dispatchEvent(event);
  return event;
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
});

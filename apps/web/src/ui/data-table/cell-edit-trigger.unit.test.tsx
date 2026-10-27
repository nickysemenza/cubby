import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CellEditTrigger } from "./cell-edit-trigger";
import {
  CELL_EDIT_EVENT,
  CellSelectionContext,
} from "./cell-selection-context";

describe("CellEditTrigger click model", () => {
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

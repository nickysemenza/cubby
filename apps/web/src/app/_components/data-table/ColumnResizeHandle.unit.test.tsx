import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { MIN_COLUMN_WIDTH } from "./useTableColumnSizing";

/**
 * The handle measures `th.offsetWidth`, which jsdom always reports as 0 — stub
 * it so a drag has a real starting width to add deltas to.
 */
function renderHandleInHeader({
  startWidth = 200,
  onCommit,
  onReset,
}: {
  startWidth?: number;
  onCommit?: (columnId: string, width: number) => void;
  onReset?: (columnId: string) => void;
}) {
  const utils = render(
    <table>
      <thead>
        <tr>
          <th data-testid="th" style={{ position: "relative" }}>
            Match
            <ColumnResizeHandle
              columnId="match"
              onCommit={onCommit}
              onReset={onReset}
            />
          </th>
        </tr>
      </thead>
    </table>,
  );
  const th = utils.getByTestId("th");
  Object.defineProperty(th, "offsetWidth", {
    value: startWidth,
    configurable: true,
  });
  return { ...utils, th, handle: th.querySelector("div") as HTMLElement };
}

describe("ColumnResizeHandle", () => {
  // The opt-out mechanism: a table with no sizing key gets no setters, and the
  // handle must disappear rather than render a dead drag target.
  it("renders nothing without onCommit", () => {
    const { th } = renderHandleInHeader({ onCommit: undefined });
    expect(th.querySelector("div")).toBeNull();
  });

  // The perf fix: committing per mousemove meant a synchronous
  // localStorage.setItem plus a full table re-render for every pixel dragged.
  it("writes width to the DOM while dragging and commits once on mouseup", () => {
    const onCommit = vi.fn();
    const { th, handle } = renderHandleInHeader({ startWidth: 200, onCommit });

    fireEvent.mouseDown(handle, { clientX: 500 });
    expect(handle.dataset.dragging).toBe("true");

    fireEvent.mouseMove(document, { clientX: 560 });
    expect(th.style.width).toBe("260px");
    fireEvent.mouseMove(document, { clientX: 620 });
    expect(th.style.width).toBe("320px");
    // Nothing committed yet — two moves, zero calls.
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.mouseUp(document, { clientX: 620 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("match", 320);
    expect(handle.dataset.dragging).toBeUndefined();
  });

  it("clamps the live drag at the minimum column width", () => {
    const onCommit = vi.fn();
    const { th, handle } = renderHandleInHeader({ startWidth: 100, onCommit });

    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 100 }); // would be -300px
    expect(th.style.width).toBe(`${MIN_COLUMN_WIDTH}px`);

    fireEvent.mouseUp(document, { clientX: 100 });
    expect(onCommit).toHaveBeenCalledWith("match", MIN_COLUMN_WIDTH);
  });

  // A click that never moves is a sort toggle, not a resize — committing the
  // unchanged width would pin the column and strand it in the reset menu.
  it("does not commit when the drag never moved", () => {
    const onCommit = vi.fn();
    const { handle } = renderHandleInHeader({ startWidth: 200, onCommit });

    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseUp(document, { clientX: 500 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("double-click resets the column", () => {
    const onCommit = vi.fn();
    const onReset = vi.fn();
    const { handle } = renderHandleInHeader({ onCommit, onReset });

    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledWith("match");
  });

  // The handle sits inside the header cell that owns the sort toggle; a bare
  // click on it must not bubble out and re-sort the table. The stand-in
  // handler has to be a React prop, not addEventListener: React delegates at
  // the root, so a native listener on the `th` fires during the real bubble
  // phase — before the synthetic handler that calls stopPropagation runs.
  it("stops click from reaching the header's sort handler", () => {
    const onHeaderClick = vi.fn();
    const { getByTestId } = render(
      <table>
        <thead>
          <tr>
            <th data-testid="th" onClick={onHeaderClick}>
              <ColumnResizeHandle
                columnId="match"
                onCommit={() => {}}
                onReset={() => {}}
              />
            </th>
          </tr>
        </thead>
      </table>,
    );

    fireEvent.click(getByTestId("th").querySelector("div") as HTMLElement);
    expect(onHeaderClick).not.toHaveBeenCalled();
  });
});

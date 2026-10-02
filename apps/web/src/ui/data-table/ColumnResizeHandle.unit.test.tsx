import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ColumnResizeHandle } from "./ColumnResizeHandle";

const firstElement = (container: HTMLElement): HTMLElement => {
  if (!(container.firstElementChild instanceof HTMLElement)) {
    throw new Error("Expected resize handle");
  }
  return container.firstElementChild;
};

describe("ColumnResizeHandle", () => {
  it("forwards mouse and touch gestures to the native v9 handler", () => {
    const resize = vi.fn();
    const { container } = render(
      <ColumnResizeHandle onResizeStart={resize} onReset={() => {}} />,
    );
    const handle = firstElement(container);

    fireEvent.mouseDown(handle);
    fireEvent.touchStart(handle);

    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("resets the native column size on double click", () => {
    const onReset = vi.fn();
    const { container } = render(
      <ColumnResizeHandle onResizeStart={() => {}} onReset={onReset} />,
    );

    fireEvent.doubleClick(firstElement(container));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("does not bubble clicks into the sort control", () => {
    const onHeaderClick = vi.fn();
    const { container } = render(
      <button type="button" onClick={onHeaderClick}>
        <ColumnResizeHandle onResizeStart={() => {}} onReset={() => {}} />
      </button>,
    );

    const handle = container.querySelector("[title]");
    expect(handle).not.toBeNull();
    if (!(handle instanceof HTMLElement)) throw new Error("Expected handle");
    fireEvent.click(handle);
    expect(onHeaderClick).not.toHaveBeenCalled();
  });
});

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ColumnResizeHandle } from "./ColumnResizeHandle";

describe("ColumnResizeHandle", () => {
  it("forwards mouse and touch gestures to the native v9 handler", () => {
    const resize = vi.fn();
    const { container } = render(
      <ColumnResizeHandle getResizeHandler={() => resize} onReset={() => {}} />,
    );
    const handle = container.firstElementChild as HTMLElement;

    fireEvent.mouseDown(handle);
    fireEvent.touchStart(handle);

    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("resets the native column size on double click", () => {
    const onReset = vi.fn();
    const { container } = render(
      <ColumnResizeHandle
        getResizeHandler={() => () => {}}
        onReset={onReset}
      />,
    );

    fireEvent.doubleClick(container.firstElementChild as HTMLElement);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("does not bubble clicks into the sort control", () => {
    const onHeaderClick = vi.fn();
    const { container } = render(
      <button type="button" onClick={onHeaderClick}>
        <ColumnResizeHandle
          getResizeHandler={() => () => {}}
          onReset={() => {}}
        />
      </button>,
    );

    fireEvent.click(container.querySelector("[title]") as HTMLElement);
    expect(onHeaderClick).not.toHaveBeenCalled();
  });
});

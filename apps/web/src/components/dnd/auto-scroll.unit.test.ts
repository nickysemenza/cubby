// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  computeDndScrollVelocity,
  createDndAutoScroller,
  findDndScrollContainer,
} from "./auto-scroll";

const rect = {
  left: 0,
  right: 200,
  top: 0,
  bottom: 100,
};

describe("computeDndScrollVelocity", () => {
  it("eases toward each enabled edge and stays still in the center", () => {
    expect(computeDndScrollVelocity(rect, { x: 100, y: 50 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      computeDndScrollVelocity(rect, { x: 0, y: 100 }, { maxSpeed: 20 }),
    ).toEqual({ x: -20, y: 20 });
    expect(
      computeDndScrollVelocity(
        rect,
        { x: 200, y: 0 },
        { axis: "horizontal", maxSpeed: 12 },
      ),
    ).toEqual({ x: 12, y: 0 });
  });
});

describe("findDndScrollContainer", () => {
  it("selects the deepest registered container under the pointer", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.append(inner);
    vi.spyOn(outer, "getBoundingClientRect").mockReturnValue({
      ...rect,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(inner, "getBoundingClientRect").mockReturnValue({
      left: 50,
      right: 150,
      top: 10,
      bottom: 90,
      width: 100,
      height: 80,
      x: 50,
      y: 10,
      toJSON: () => ({}),
    });

    expect(findDndScrollContainer([outer, inner], { x: 75, y: 50 })).toBe(
      inner,
    );
    expect(findDndScrollContainer([outer, inner], { x: 20, y: 50 })).toBe(
      outer,
    );
  });
});

describe("createDndAutoScroller", () => {
  it("stops scheduling when the container cannot move farther", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      ...rect,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    container.scrollBy = vi.fn();
    const onScroll = vi.fn();
    const scroller = createDndAutoScroller({ onScroll });

    scroller.update({ x: 200, y: 50 }, [container]);
    callbacks.shift()?.(0);

    expect(container.scrollBy).toHaveBeenCalledWith({ left: 18, top: 0 });
    expect(onScroll).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(0);
    scroller.stop();
    vi.unstubAllGlobals();
  });
});

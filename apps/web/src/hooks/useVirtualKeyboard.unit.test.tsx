import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useAppViewportBounds } from "./useVirtualKeyboard";

function ViewportOwner() {
  useAppViewportBounds();
  return null;
}

afterEach(() => vi.unstubAllGlobals());

it("keeps portalled sheets inside the visible viewport as the keyboard opens and pans", () => {
  const viewport = Object.assign(new EventTarget(), {
    height: 874,
    offsetTop: 0,
  });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 874);
  const { unmount } = render(<ViewportOwner />);
  const style = document.documentElement.style;
  expect(style.getPropertyValue("--app-viewport-height")).toBe("874px");
  act(() => {
    viewport.height = 490;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(style.getPropertyValue("--app-viewport-height")).toBe("490px");
  expect(style.getPropertyValue("--app-viewport-bottom")).toBe("384px");
  act(() => {
    viewport.offsetTop = 50;
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(style.getPropertyValue("--app-viewport-bottom")).toBe("334px");
  unmount();
  expect(style.getPropertyValue("--app-viewport-height")).toBe("");
});

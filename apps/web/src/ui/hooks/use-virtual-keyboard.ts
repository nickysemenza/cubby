import { useEffect, useState } from "react";

/** The authenticated shell publishes visible bounds for portalled phone sheets. */
export function useAppViewportBounds() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    const update = () => {
      style.setProperty("--app-viewport-height", `${viewport.height}px`);
      style.setProperty(
        "--app-viewport-bottom",
        `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      style.removeProperty("--app-viewport-height");
      style.removeProperty("--app-viewport-bottom");
    };
  }, []);
}

export function detectSoftwareKeyboard(
  layoutHeight: number,
  viewportHeight: number,
  viewportOffsetTop = 0,
) {
  const occluded = layoutHeight - viewportHeight - viewportOffsetTop;
  return occluded > 120 && viewportHeight / layoutHeight < 0.8;
}

/** iOS does not expose keyboard state; visualViewport is the stable signal. */
export function useVirtualKeyboard() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      setOpen(
        detectSoftwareKeyboard(
          window.innerHeight,
          viewport.height,
          viewport.offsetTop,
        ),
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return open;
}

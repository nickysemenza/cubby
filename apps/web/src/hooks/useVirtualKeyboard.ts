import { useEffect, useState } from "react";

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

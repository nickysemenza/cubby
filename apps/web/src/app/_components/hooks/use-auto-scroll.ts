import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { type RefObject, useEffect } from "react";

/**
 * Register edge auto-scroll on a scroll container while a drag is in progress.
 * Shared by the locations arrange surface and the tasks board — both wrap their
 * horizontally-scrolling drag areas in a ref and hand it here.
 */
export function useAutoScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return autoScrollForElements({ element });
  }, [ref]);
}

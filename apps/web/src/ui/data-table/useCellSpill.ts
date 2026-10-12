import { type RefObject, useEffect } from "react";

const SPILL_DELAY_MS = 250;
const SPILL_MAX_PX = 480;
const EDGE_PX = 4;
/** What a cell can spill, outermost first in document order. */
const SOURCES = "[data-cell-spill], [data-cell-value], .truncate";
const TYPOGRAPHY = [
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant-numeric",
  "font-feature-settings",
  "letter-spacing",
  "line-height",
];

const isClipped = (element: Element) =>
  element.scrollWidth > element.clientWidth + 1;

/**
 * The element whose full value a cell should spill, or null when nothing in
 * it is clipped. Wrapping chip clusters count their own overflow and inputs
 * are being edited, so neither spills.
 */
function clippedSource(cell: HTMLElement): HTMLElement | null {
  if (
    cell.querySelector(
      "[data-cell-wrap], input, textarea, select, [contenteditable=true]",
    )
  )
    return null;
  for (const candidate of cell.querySelectorAll<HTMLElement>(SOURCES)) {
    if (
      isClipped(candidate) ||
      [...candidate.querySelectorAll("*")].some(isClipped)
    )
      return candidate;
  }
  // Plain text clipped by the cell's own content box.
  const content = cell.firstElementChild;
  if (content instanceof HTMLElement && isClipped(content)) {
    const inner = content.firstElementChild;
    return inner instanceof HTMLElement ? inner : content;
  }
  return null;
}

/** The value laid out on one unclipped line, without ids or live controls. */
function unclippedClone(source: HTMLElement) {
  const clone = source.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return null;
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    element.removeAttribute("id");
    element.removeAttribute("title");
    element.style.overflow = "visible";
    element.style.textOverflow = "clip";
    element.style.maxWidth = "none";
    element.style.minWidth = "0";
    element.style.flexShrink = "0";
    element.style.whiteSpace = "nowrap";
  }
  clone.style.width = "max-content";
  return clone;
}

/**
 * Lifts a clipped table value over its neighbours at the same row height
 * while the pointer (after a short delay) or keyboard focus is on its cell,
 * so a narrow column never hides a value. The overlay is inert and
 * pointer-transparent: clicks still reach the cell beneath, and leaving the
 * cell removes it. Near the pane's end edge it grows toward the start.
 */
export function useCellSpill(
  pane: RefObject<HTMLElement | null>,
  enabled = true,
) {
  useEffect(() => {
    const root = pane.current;
    if (!enabled || !root) return;
    let timer = 0;
    let current: HTMLElement | null = null;
    let overlay: HTMLElement | null = null;

    const hide = () => {
      window.clearTimeout(timer);
      overlay?.remove();
      overlay = null;
      current = null;
    };

    const show = (cell: HTMLElement) => {
      const source = clippedSource(cell);
      const clone = source && unclippedClone(source);
      if (!source || !clone) return;
      const cellBox = cell.getBoundingClientRect();
      const sourceBox = source.getBoundingClientRect();
      const typography = getComputedStyle(source);
      const element = document.createElement("div");
      element.dataset.cellSpillOverlay = "";
      element.setAttribute("aria-hidden", "true");
      element.inert = true;
      for (const property of TYPOGRAPHY)
        element.style.setProperty(
          property,
          typography.getPropertyValue(property),
        );
      Object.assign(element.style, {
        position: "fixed",
        zIndex: "60",
        top: `${cellBox.top}px`,
        left: `${sourceBox.left - EDGE_PX}px`,
        height: `${cellBox.height}px`,
        maxWidth: `${SPILL_MAX_PX}px`,
        display: "flex",
        alignItems: "center",
        padding: `0 ${EDGE_PX}px`,
        overflow: "hidden",
        whiteSpace: "nowrap",
        boxSizing: "border-box",
        pointerEvents: "none",
        background: "var(--popover, var(--card))",
        borderRadius: "4px",
        boxShadow:
          "0 2px 10px rgb(23 26 33 / 0.14), 0 0 0 1px rgb(23 26 33 / 0.08)",
      });
      element.append(clone);
      document.body.append(element);
      const limit =
        Math.min(root.getBoundingClientRect().right, window.innerWidth) -
        EDGE_PX;
      const box = element.getBoundingClientRect();
      if (box.right > limit)
        element.style.left = `${Math.max(EDGE_PX, limit - box.width)}px`;
      overlay = element;
    };

    const schedule = (cell: HTMLElement) => {
      if (cell === current) return;
      hide();
      current = cell;
      timer = window.setTimeout(() => {
        if (current === cell && cell.isConnected) show(cell);
      }, SPILL_DELAY_MS);
    };

    const cellOf = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest<HTMLElement>("td[data-column-id]")
        : null;

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const cell = cellOf(event.target);
      if (cell && root.contains(cell)) schedule(cell);
      else hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const cell = cellOf(event.target);
      if (cell) schedule(cell);
    };

    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerleave", hide);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", hide);
    root.addEventListener("pointerdown", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("wheel", hide, { passive: true });
    return () => {
      hide();
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerleave", hide);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("pointerdown", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide);
    };
  }, [pane, enabled]);
}

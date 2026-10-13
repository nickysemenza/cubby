import { type RefObject, useEffect } from "react";

const SPILL_DELAY_MS = 250;
const SPILL_MAX_PX = 480;
const EDGE_PX = 4;
/** What a cell can spill, outermost first in document order. */
const SOURCES =
  "[data-cell-spill], [data-cell-spill-text], [data-cell-value], [data-stacked-line], [data-header-label], .truncate";
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

const RAIL_GAP_PX = 2;

/**
 * Cut off sideways, or below its last line when clamped to two. Screen-reader
 * text is clipped on purpose; counting it spilled values that fit.
 */
const isClipped = (element: Element) =>
  !element.matches(".sr-only") &&
  (element.scrollWidth > element.clientWidth + 1 ||
    element.scrollHeight > element.clientHeight + 1);

const needsSpill = (element: Element) =>
  element.hasAttribute("data-cell-spill-text") || isClipped(element);

const railsOf = (cell: HTMLElement) => [
  ...cell.querySelectorAll<HTMLElement>("[data-cell-rail]"),
];

/** The active row's rail when it floats over the cell instead of in flow. */
function floatingRail(cell: HTMLElement) {
  return (
    railsOf(cell).find(
      (rail) => getComputedStyle(rail).position === "absolute",
    ) ?? null
  );
}

/**
 * The rail beside the spilled value, which the overlay would paint over.
 * Regression: a value inside its own in-flow frame (a suggestion mark) put
 * that frame's rail first, so the outer ⓘ was neither copied nor cleared.
 */
function outerRail(cell: HTMLElement, source: HTMLElement) {
  return (
    railsOf(cell).find(
      (rail) => !source.contains(rail) && rail.getClientRects().length > 0,
    ) ?? null
  );
}

/** Whether a floating rail paints over the value's text. */
function railCovers(value: HTMLElement, rail: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(value);
  const text = range.getBoundingClientRect();
  const box = rail.getBoundingClientRect();
  return text.width > 0 && text.left < box.right && text.right > box.left;
}

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
      needsSpill(candidate) ||
      [...candidate.querySelectorAll("*")].some(needsSpill)
    )
      // A stacked line spills with its partner line, as the cell shows them.
      return candidate.matches("[data-stacked-line]") && candidate.parentElement
        ? candidate.parentElement
        : candidate;
  }
  // A value that exactly fits still loses its tail (or a number its leading
  // digits) under the active row's ⓘ.
  const rail = floatingRail(cell);
  const value = cell.querySelector<HTMLElement>("[data-cell-value]");
  if (rail && value && railCovers(value, rail)) return value;
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
  // Stand-ins for hidden text (a code's "…") give way to the text itself.
  for (const omitted of clone.querySelectorAll("[data-spill-omit]"))
    omitted.remove();
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    const fullText = element.getAttribute("data-cell-spill-text");
    if (fullText !== null) {
      element.textContent = fullText;
      element.removeAttribute("data-cell-spill-text");
    }
    element.removeAttribute("id");
    element.removeAttribute("title");
    element.style.overflow = "visible";
    element.style.textOverflow = "clip";
    element.style.maxWidth = "none";
    element.style.minWidth = "0";
    element.style.flexShrink = "0";
    element.style.whiteSpace = "nowrap";
    element.style.setProperty("-webkit-line-clamp", "none");
  }
  clone.style.width = "max-content";
  return clone;
}

/**
 * The cell's rail (its ⓘ) drawn at the spill-over's end, or
 * its start beside a number, where padding keeps it clear of the full text.
 * Regression: drawn at its own spot, it hid the characters it sat on. The
 * copy forwards clicks to the real controls.
 */
function railCopy(
  rail: HTMLElement,
  start: boolean,
  overlay: HTMLElement,
  done: () => void,
) {
  const clone = rail.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return;
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")])
    element.removeAttribute("id");
  clone.removeAttribute("data-cell-rail");
  clone.dataset.cellSpillRail = "";
  Object.assign(clone.style, {
    position: "absolute",
    inset: "auto",
    margin: "0",
    top: "50%",
    transform: "translateY(-50%)",
    [start ? "left" : "right"]: `${EDGE_PX}px`,
    background: "var(--popover, var(--card))",
    boxShadow: "none",
    pointerEvents: "none",
    visibility: "visible",
  });
  const controls = [...rail.querySelectorAll<HTMLElement>("button, a")];
  // Only copied controls take the pointer: a decorative glyph (a header's
  // sort arrow) passes clicks through to the cell, which sorts.
  clone.querySelectorAll<HTMLElement>("button, a").forEach((copy, index) => {
    copy.tabIndex = -1;
    copy.style.pointerEvents = "auto";
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      done();
      controls[index]?.click();
    });
  });
  overlay.append(clone);
}

/**
 * Lifts a clipped table value over its neighbours at the same row height
 * while the pointer (after a short delay) or keyboard focus is on its cell,
 * so a narrow column never hides a value. The overlay is pointer-transparent
 * apart from its rail copy: clicks still reach the cell beneath, and leaving
 * the cell removes it. Near the pane's end edge it grows toward the start.
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
      const rail = outerRail(cell, source);
      const railBox = rail?.getBoundingClientRect();
      const start =
        !!railBox &&
        railBox.left - cellBox.left < cellBox.right - railBox.right;
      const space = railBox ? railBox.width + RAIL_GAP_PX : 0;
      if (railBox && start) {
        element.style.left = `${sourceBox.left - EDGE_PX - space}px`;
        element.style.paddingLeft = `${EDGE_PX + space}px`;
      } else if (railBox) element.style.paddingRight = `${EDGE_PX + space}px`;
      element.append(clone);
      document.body.append(element);
      const limit =
        Math.min(root.getBoundingClientRect().right, window.innerWidth) -
        EDGE_PX;
      const box = element.getBoundingClientRect();
      if (box.right > limit)
        element.style.left = `${Math.max(EDGE_PX, limit - box.width)}px`;
      if (rail) railCopy(rail, start, element, hide);
      element.addEventListener("pointerleave", (event) => {
        if (
          !(
            event.relatedTarget instanceof Node &&
            cell.contains(event.relatedTarget)
          )
        )
          hide();
      });
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
        ? target.closest<HTMLElement>("td[data-column-id], th[data-column-id]")
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

    // The rail copy sits outside the pane; reaching it keeps the overlay.
    const onPointerLeave = (event: PointerEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        overlay?.contains(event.relatedTarget)
      )
        return;
      hide();
    };

    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", hide);
    root.addEventListener("pointerdown", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("wheel", hide, { passive: true });
    return () => {
      hide();
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("pointerdown", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide);
    };
  }, [pane, enabled]);
}

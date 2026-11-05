import { type RefObject, useEffect } from "react";

import { setAnchorProxy } from "~/ui/overlays/anchor-proxy";

import { RAIL_POPUP_OPEN } from "./row-activity";

const SPILL_DELAY_MS = 250;
/**
 * How long a closed popup's overlay waits for focus to come back to its
 * cell's ⓘ (Base UI returns it after the exit animation).
 */
const RELEASE_SETTLE_MS = 400;
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
export function railCovers(value: HTMLElement, rail: HTMLElement) {
  const range = document.createRange();
  // Layout-free DOMs (jsdom) have no range geometry: nothing is covered.
  if (typeof range.getBoundingClientRect !== "function") return false;
  const box = rail.getBoundingClientRect();
  // Text glyphs only: a range over the whole value also spans the boxes of
  // full-width wrappers (a nested frame) and reported a cover that wasn't.
  const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || rail.contains(node)) continue;
    // An inline box sized to its value (a fixed-width figure) counts whole.
    const parent = node.parentElement;
    const inlineBox =
      parent &&
      parent !== value &&
      !parent.matches("[data-cell-value], [data-cell-frame]") &&
      getComputedStyle(parent).display.startsWith("inline");
    range.selectNodeContents(node);
    const text = inlineBox
      ? parent.getBoundingClientRect()
      : range.getBoundingClientRect();
    if (text.width > 0 && text.left < box.right && text.right > box.left)
      return true;
  }
  return false;
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

/**
 * The value laid out on one unclipped line, without ids or live controls,
 * with each copied element mapped back to the original it stands in for.
 */
function unclippedClone(source: HTMLElement) {
  const clone = source.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return null;
  // A deep clone keeps document order, so the two element lists align.
  const originals = new WeakMap<Element, HTMLElement>();
  const sourceElements = [source, ...source.querySelectorAll<HTMLElement>("*")];
  [clone, ...clone.querySelectorAll("*")].forEach((copy, index) => {
    const original = sourceElements[index];
    if (original) originals.set(copy, original);
  });
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
  return { clone, originals };
}

const FORWARDED_EVENTS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "dblclick",
] as const;

/**
 * The cell's rail (its ⓘ) drawn at the spill-over's end, or
 * its start beside a number, where padding keeps it clear of the full text.
 * Regression: drawn at its own spot, it hid the characters it sat on. The
 * copy forwards clicks to the real controls; a popup trigger's copy `pin`s
 * the overlay as that popup's anchor instead of ending the spill.
 */
function railCopy(
  rail: HTMLElement,
  start: boolean,
  overlay: HTMLElement,
  done: () => void,
  pin: (trigger: HTMLElement, proxy: HTMLElement) => void,
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
    // A rail standing aside for clipped text is transparent in place; its
    // copy at the spill's end is the visible one.
    opacity: "1",
  });
  const controls = [...rail.querySelectorAll<HTMLElement>("button, a")];
  // Only copied controls take the pointer: a decorative glyph (a header's
  // sort arrow) passes clicks through to the cell, which sorts.
  clone.querySelectorAll<HTMLElement>("button, a").forEach((copy, index) => {
    copy.tabIndex = -1;
    copy.style.pointerEvents = "auto";
    // Pressing an open popup's copy closes it as an outside press; the click
    // that follows must not reopen it.
    let wasOpen = false;
    copy.addEventListener("pointerdown", () => {
      wasOpen = controls[index]?.getAttribute("aria-expanded") === "true";
    });
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const control = controls[index];
      if (!control || wasOpen) return;
      if (control.hasAttribute("aria-haspopup")) pin(control, copy);
      else done();
      control.click();
    });
  });
  clone.addEventListener("pointerdown", (event) => event.preventDefault());
  overlay.append(clone);
}

/**
 * Lifts a clipped table value over its neighbours at the same row height
 * while the pointer (after a short delay) or keyboard focus is on its cell,
 * so a narrow column never hides a value. The whole overlay belongs to the
 * source cell: presses forward there, and its copied rail forwards to the
 * real controls. Leaving both the cell and overlay removes it. Near the pane's
 * end edge it grows toward the start.
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
    // A popup opened from the overlay's copied rail. While it is open the
    // overlay is its anchor and stays up; the rest of the pane shows no
    // other spill.
    let pinned: {
      trigger: HTMLElement;
      cell: HTMLElement;
      observer: MutationObserver;
    } | null = null;

    const unpin = () => {
      if (!pinned) return;
      pinned.observer.disconnect();
      setAnchorProxy(pinned.trigger, null);
      pinned = null;
    };

    const hide = () => {
      unpin();
      window.clearTimeout(timer);
      overlay?.remove();
      overlay = null;
      current = null;
    };

    // Escape returns focus to the cell's own ⓘ, which shows in place over
    // the clipped text unless the overlay still covers it.
    const release = () => {
      const cell = pinned?.cell;
      unpin();
      timer = window.setTimeout(() => {
        if (current === cell && !cell?.contains(document.activeElement)) hide();
      }, RELEASE_SETTLE_MS);
    };

    const pin = (
      cell: HTMLElement,
      trigger: HTMLElement,
      proxy: HTMLElement,
    ) => {
      unpin();
      setAnchorProxy(trigger, proxy);
      let opened = false;
      const observer = new MutationObserver(() => {
        const expanded = trigger.getAttribute("aria-expanded");
        if (expanded) proxy.setAttribute("aria-expanded", expanded);
        proxy.toggleAttribute(
          "data-popup-open",
          trigger.hasAttribute("data-popup-open"),
        );
        if (expanded === "true") opened = true;
        else if (opened) release();
      });
      observer.observe(trigger, {
        attributes: true,
        attributeFilter: ["aria-expanded", "data-popup-open"],
      });
      pinned = { trigger, cell, observer };
      // A trigger that never opens (a disabled explanation) lets go.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (pinned?.trigger === trigger && !opened) release();
        }),
      );
    };

    // Scrolling the table or page moves the row out from under the popup.
    const closePinned = () => {
      const trigger = pinned?.trigger;
      hide();
      if (trigger?.getAttribute("aria-expanded") === "true") trigger.click();
    };

    const show = (cell: HTMLElement) => {
      const source = clippedSource(cell);
      const copy = source && unclippedClone(source);
      if (!source || !copy) return;
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
        pointerEvents: "auto",
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
      element.append(copy.clone);
      document.body.append(element);
      const limit =
        Math.min(root.getBoundingClientRect().right, window.innerWidth) -
        EDGE_PX;
      const box = element.getBoundingClientRect();
      if (box.right > limit)
        element.style.left = `${Math.max(EDGE_PX, limit - box.width)}px`;
      if (rail)
        railCopy(rail, start, element, hide, (trigger, proxy) =>
          pin(cell, trigger, proxy),
        );
      // Presses replay on the original under the copied element, so a
      // clipped link, suggestion accept or edit trigger acts, and selection
      // (the cell's mousedown) moves, even where the spill paints over a
      // neighbouring cell; blank overlay space stands for the cell. The real
      // pointerdown is left uncancelled so the browser still sends the
      // mousedown that selection listens for.
      const originalOf = (target: EventTarget | null) => {
        for (
          let node = target instanceof Element ? target : null;
          node && node !== element;
          node = node.parentElement
        ) {
          const original = copy.originals.get(node);
          if (original) return original;
        }
        return cell;
      };
      for (const type of FORWARDED_EVENTS) {
        element.addEventListener(type, (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(
              "[data-cell-spill-rail] button, [data-cell-spill-rail] a",
            )
          )
            return;
          if (type !== "pointerdown") event.preventDefault();
          event.stopPropagation();
          const target = originalOf(event.target);
          const EventClass = type.startsWith("pointer")
            ? PointerEvent
            : MouseEvent;
          target.dispatchEvent(new EventClass(type, event));
          // Held through a plain click so a double-click can still open the
          // editor; a control's click or a double-click ends the spill.
          // Removing it on press would retarget the click beneath it.
          if (
            type === "dblclick" ||
            (type === "click" &&
              target.closest("a, button, [data-cell-edit-trigger]"))
          )
            hide();
        });
      }
      element.addEventListener("pointerleave", (event) => {
        if (
          !pinned &&
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

    // Regression: a header's spill (its start-edge source ⓘ copy) covered the
    // column's reorder grip, so pressing after resting on the grip hit the
    // overlay and never started the drag.
    const cellOf = (target: EventTarget | null) =>
      target instanceof Element && !target.closest("[data-cell-spill-off]")
        ? target.closest<HTMLElement>("td[data-column-id], th[data-column-id]")
        : null;

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      // A rail popup holds its cell; crossing others on the way to it must
      // not raise their spills over its path.
      if (pinned || root.querySelector(RAIL_POPUP_OPEN)) return;
      const cell = cellOf(event.target);
      if (cell && root.contains(cell)) schedule(cell);
      else hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const cell = cellOf(event.target);
      if (cell) schedule(cell);
      else hide();
    };

    // A real press elsewhere in the pane ends the spill; presses the overlay
    // forwards to its source cell are synthetic and keep it until the click.
    const onPointerDown = (event: PointerEvent) => {
      if (event.isTrusted) hide();
    };

    // The rail copy sits outside the pane; reaching it keeps the overlay.
    const onPointerLeave = (event: PointerEvent) => {
      if (
        pinned ||
        (event.relatedTarget instanceof Node &&
          overlay?.contains(event.relatedTarget))
      )
        return;
      hide();
    };
    // Focus moving into the pinned popup keeps its anchor.
    const onFocusOut = () => {
      if (!pinned) hide();
    };
    // The popup's own scrolling content leaves it open; the pane or page
    // scrolling under it closes it.
    const onScroll = (event: Event) => {
      if (!pinned) hide();
      else if (
        event.target instanceof Node &&
        event.target.contains(pinned.cell)
      )
        closePinned();
    };
    const onWheel = (event: WheelEvent) => {
      if (!pinned) hide();
      else if (event.target instanceof Node && root.contains(event.target))
        closePinned();
    };

    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      hide();
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("wheel", onWheel);
    };
  }, [pane, enabled]);
}

import type { RowData } from "@tanstack/react-table";
import { type RefObject, useEffect, useState } from "react";

import { isLockedColumn, MIN_COLUMN_WIDTH } from "./column-layout";
import type { CubbyTable } from "./table-features";

const SAMPLE_ROWS = 12;
const HEADER_CAP = 160;
/** A two-line header's widest line is at least about half its label. */
const HEADER_LINE_SHARE = 0.55;
const INHERITED_TYPOGRAPHY = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-variant-numeric",
  "font-variant-ligatures",
  "font-feature-settings",
  "font-variation-settings",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "direction",
  "white-space",
];

/** Measure painted primitives without editing live cells or their drafts. */
function naturalCell(cell: HTMLElement) {
  const clone = cell.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return null;
  clone.removeAttribute("id");
  clone.style.cssText =
    "display:block;position:static;width:max-content;min-width:0;max-width:none;inset:auto;";
  // Offscreen clones leave the live table's ancestor chain. Keep resolved
  // typography, including footer weight and numeric variants, for honest fit.
  const typography = getComputedStyle(cell);
  for (const property of INHERITED_TYPOGRAPHY) {
    clone.style.setProperty(property, typography.getPropertyValue(property));
  }
  // Hover-only controls must never change the column fit. Value edits keep the
  // previous fit until their display renderer returns.
  for (const pencil of clone.querySelectorAll(
    "[data-cell-edit-pencil], button[aria-label^='Reorder '], [title='Drag to resize · double-click to reset']",
  ))
    pencil.remove();
  // Fits only grow, so a 48px loading bar would hold every lazily loaded
  // column at 57px after its "0" arrives. Skipping the whole cell instead
  // left a column with a lasting busy mark at its header's width.
  for (const busy of clone.querySelectorAll("[aria-busy='true']"))
    busy.remove();
  // A code's middle is hidden behind a drawn "…"; fit that form.
  for (const elided of clone.querySelectorAll("[data-fit-elide]"))
    elided.remove();
  for (const element of clone.querySelectorAll<HTMLElement>("*")) {
    element.removeAttribute("id");
    element.style.maxWidth = "none";
    if (
      element.matches(
        "[data-cell-frame], [data-cell-value], .truncate, .w-full",
      )
    ) {
      element.style.width = "max-content";
      element.style.flex = "0 0 auto";
    }
  }
  return clone;
}

const labelOf = (clone: HTMLElement) =>
  clone.querySelector<HTMLElement>("[data-header-label]");

/** The header clone with its label shrunk to its longest word. */
function wrappedHeaderClone(cell: HTMLElement) {
  const clone = naturalCell(cell);
  const label = clone && labelOf(clone);
  if (!clone || !label) return undefined;
  label.style.width = "min-content";
  label.style.flex = "0 0 auto";
  return clone;
}

/**
 * Header labels wrap to two lines, so the label's share of the width is its
 * longest word or about half its one-line width, whichever is wider.
 */
function twoLineHeaderWidth(clone: HTMLElement, wrapped: HTMLElement) {
  const painted = clone.getBoundingClientRect().width;
  const label = labelOf(clone)?.getBoundingClientRect().width ?? 0;
  const word = labelOf(wrapped)?.getBoundingClientRect().width ?? 0;
  return Math.ceil(painted - label + Math.max(word, label * HEADER_LINE_SHARE));
}

type FitSample = {
  id: string;
  header: boolean;
  clone: HTMLElement;
  /** A header's label wrapped at its longest word. */
  wrapped?: HTMLElement;
};

/** The offscreen clones that measure one cell, or none for unfit content. */
function fitSample(id: string, cell: HTMLElement): FitSample | null {
  if (cell.querySelector("input,textarea,[contenteditable=true]")) return null;
  const clone = naturalCell(cell);
  if (!clone) return null;
  // Wrapping chip clusters fill whatever width the column has; on one line
  // they would claim the column's whole maximum. Fit their first chip, or a
  // single relation column shrinks to its header and clips its only chip.
  for (const wrap of clone.querySelectorAll("[data-cell-wrap]")) {
    for (const chip of [...wrap.querySelectorAll("[data-chip]")].slice(1))
      chip.remove();
    for (const more of wrap.querySelectorAll("[data-chip-overflow]"))
      more.remove();
  }
  const header = cell.tagName === "TH";
  return {
    id,
    header,
    clone,
    wrapped: header ? wrappedHeaderClone(cell) : undefined,
  };
}

function sampleWidth(sample: FitSample) {
  const painted = Math.ceil(sample.clone.getBoundingClientRect().width);
  if (painted === 0 || !sample.header) return painted;
  const header = sample.wrapped
    ? twoLineHeaderWidth(sample.clone, sample.wrapped)
    : painted;
  return Math.min(header, HEADER_CAP);
}

export function renderedColumnFitScope<TData extends RowData>(
  table: CubbyTable<TData>,
) {
  return JSON.stringify([
    table.getVisibleLeafColumns().map((column) => column.id),
    table.state.columnFilters,
    table.state.sorting,
    table.state.pagination?.pageIndex,
    table.getRowModel().rows[0]?.id,
  ]);
}

/**
 * In-session content widths are separate from deliberate TanStack resizing.
 * One inert, offscreen batch samples headers and at most twelve rendered rows;
 * widths only grow within the current data/query scope, including enrichment.
 */
export function useRenderedColumnWidths<TData extends RowData>(
  table: CubbyTable<TData>,
  container: RefObject<HTMLElement | null>,
  scope: string,
  enabled: boolean,
): Readonly<Record<string, number>> {
  const [fit, setFit] = useState<{
    scope: string;
    widths: Record<string, number>;
  }>({ scope, widths: {} });
  const columnsKey = table
    .getVisibleLeafColumns()
    .map((column) => column.id)
    .join(",");

  useEffect(() => {
    const pane = container.current;
    if (!enabled || !pane) return;
    let frame = 0;
    let stopped = false;
    const measure = () => {
      frame = 0;
      const sourceTable = pane.querySelector("table");
      if (!sourceTable || sourceTable.getBoundingClientRect().width === 0)
        return;
      const headers = [
        ...sourceTable.querySelectorAll<HTMLElement>(
          "thead th[data-column-id]",
        ),
      ];
      const rows = [
        ...sourceTable.querySelectorAll<HTMLElement>("tbody tr[data-cell-row]"),
      ].slice(0, SAMPLE_ROWS);
      const cells = [
        ...headers,
        ...sourceTable.querySelectorAll<HTMLElement>(
          "tfoot td[data-column-id]",
        ),
        ...rows.flatMap((row) => [
          ...row.querySelectorAll<HTMLElement>("td[data-column-id]"),
        ]),
      ];
      const host = document.createElement("div");
      host.className = sourceTable.className;
      host.setAttribute("aria-hidden", "true");
      host.inert = true;
      host.style.cssText =
        "position:fixed;left:-100000px;top:0;width:max-content;visibility:hidden;pointer-events:none;";
      const samples: FitSample[] = [];
      for (const cell of cells) {
        const id = cell.dataset.columnId;
        const column = id ? table.getColumn(id) : undefined;
        if (!id || !column || isLockedColumn(column)) continue;
        const sample = fitSample(id, cell);
        if (!sample) continue;
        host.append(sample.clone);
        if (sample.wrapped) host.append(sample.wrapped);
        samples.push(sample);
      }
      // All writes precede all layout reads; remove the inert batch only after
      // the reads finish. No React components or network requests are mounted.
      document.body.append(host);
      const widths: Record<string, number> = {};
      for (const sample of samples) {
        const natural = sampleWidth(sample);
        if (natural === 0) continue;
        widths[sample.id] = Math.max(widths[sample.id] ?? 0, natural);
      }
      host.remove();
      for (const [id, width] of Object.entries(widths)) {
        const column = table.getColumn(id);
        if (!column) continue;
        widths[id] = Math.max(
          column.columnDef.minSize ?? MIN_COLUMN_WIDTH,
          Math.min(width, column.columnDef.maxSize ?? 320),
        );
      }
      if (stopped) return;
      setFit((previous) => {
        const current = previous.scope === scope ? previous.widths : {};
        const next = { ...current };
        let changed = previous.scope !== scope;
        for (const [id, width] of Object.entries(widths)) {
          if (width <= (current[id] ?? 0)) continue;
          next[id] = width;
          changed = true;
        }
        return changed ? { scope, widths: next } : previous;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new MutationObserver(schedule);
    // Attribute changes include hover, focus, fitted CSS variables and live
    // editing state. Only changed content needs a fresh natural-width read.
    observer.observe(pane, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    schedule();
    void document.fonts?.ready.then(() => {
      if (!stopped) schedule();
    });
    return () => {
      stopped = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [table, container, scope, enabled, columnsKey]);

  return fit.scope === scope ? fit.widths : {};
}

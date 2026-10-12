import type { RowData } from "@tanstack/react-table";
import { type RefObject, useEffect, useState } from "react";

import { isLockedColumn } from "./column-layout";
import type { CubbyTable } from "./table-features";

const SAMPLE_ROWS = 12;
const HEADER_CAP = 160;

/** Measure painted primitives without editing live cells or their drafts. */
function naturalCell(cell: HTMLElement) {
  const clone = cell.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return null;
  clone.removeAttribute("id");
  clone.style.cssText =
    "display:block;position:static;width:max-content;min-width:0;max-width:none;inset:auto;";
  // Hover-only controls must never change the column fit. Value edits keep the
  // previous fit until their display renderer returns.
  for (const pencil of clone.querySelectorAll(
    "[data-cell-edit-pencil], button[aria-label^='Reorder '], [title='Drag to resize · double-click to reset']",
  ))
    pencil.remove();
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
      const samples: Array<{
        id: string;
        header: boolean;
        clone: HTMLElement;
      }> = [];
      for (const cell of cells) {
        const id = cell.dataset.columnId;
        const column = id ? table.getColumn(id) : undefined;
        if (!id || !column || isLockedColumn(column)) continue;
        if (cell.querySelector("input,textarea,[contenteditable=true]"))
          continue;
        const clone = naturalCell(cell);
        if (!clone) continue;
        host.append(clone);
        samples.push({ id, header: cell.tagName === "TH", clone });
      }
      // All writes precede all layout reads; remove the inert batch only after
      // the reads finish. No React components or network requests are mounted.
      document.body.append(host);
      const widths: Record<string, number> = {};
      for (const sample of samples) {
        const painted = Math.ceil(sample.clone.getBoundingClientRect().width);
        if (painted === 0) continue;
        const natural = sample.header ? Math.min(painted, HEADER_CAP) : painted;
        widths[sample.id] = Math.max(widths[sample.id] ?? 0, natural);
      }
      host.remove();
      for (const [id, width] of Object.entries(widths)) {
        const column = table.getColumn(id);
        if (!column) continue;
        widths[id] = Math.max(
          column.columnDef.minSize ?? 48,
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

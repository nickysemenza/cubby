import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { ROW_DENSITY } from "./density";

/**
 * The band's fixed height in px at or above `md`, border included. It tracks the
 * row height (`--table-row-height`). The desktop virtualizer budgets this size
 * without measuring, so the band must not grow.
 */
export const sectionHeaderHeight = () => ROW_DENSITY.rowHeight;

/** A section total drawn under its own column. */
export interface SectionColumnTotal {
  columnId: string;
  /** Inset from the table's start edge; a CSS length over the column widths. */
  start: string;
  width: string;
  numeric: boolean;
  node: ReactNode;
}

interface SectionHeaderProps {
  title: string;
  count: number;
  depth?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  /** "Filter to this": present only when the grouped field has a declared filter. */
  onFilter?: () => void;
  /** "Hide": excludes the section's value, keeping the grouping. */
  onHide?: () => void;
  /** Beside the label and count: a record link the plain label cannot carry. */
  aside?: ReactNode;
  /** The section's own commands, always visible at the trailing edge. */
  actions?: ReactNode;
  /** Totals aligned under their columns; the band spans the table's full width. */
  columnTotals?: readonly SectionColumnTotal[];
  /** Totals with no column here: printed beside the label, each named. */
  labelledTotals?: readonly {
    columnId: string;
    label: string;
    node: ReactNode;
  }[];
  className?: string;
}

const ACTION_CLASS =
  "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/section:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:opacity-100";

/**
 * Header of one grouped-list section: a neutral band with the section's
 * label and its count over the whole filtered set. "Filter to this" and
 * "Hide" reveal on hover and stay reachable by keyboard.
 */
export function SectionHeader({
  title,
  count,
  depth = 0,
  collapsed = false,
  onToggle,
  onFilter,
  onHide,
  aside,
  actions,
  columnTotals,
  labelledTotals,
  className,
}: SectionHeaderProps) {
  return (
    <div
      data-slot="list-section-header"
      className={cn(
        "group/section relative flex h-11 items-center gap-2 border-b border-hairline-soft bg-card px-2 md:h-(--table-row-height) md:bg-muted",
        className,
      )}
    >
      {columnTotals?.map((total) => (
        <span
          key={total.columnId}
          data-section-total={total.columnId}
          className={cn(
            "absolute inset-y-0 flex items-center truncate px-1 text-xs tabular-nums",
            total.numeric && "justify-end",
          )}
          style={{ insetInlineStart: total.start, width: total.width }}
        >
          {total.node}
        </span>
      ))}
      <div
        // The label stays readable on a horizontally scrolled table: the band
        // spans every column, and the sticky run parks at the pane's edge.
        className="sticky left-2 z-10 flex min-w-0 items-center gap-2 bg-card md:bg-muted"
        style={{ paddingInlineStart: `${depth * 12}px` }}
      >
        <h3 aria-label={title} className="min-w-0 truncate text-sm font-medium">
          {onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
              className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-(--table-row-height)"
            >
              <CaretRightIcon
                aria-hidden
                className={cn(
                  "size-3 shrink-0 text-muted-foreground",
                  !collapsed && "rotate-90",
                )}
              />
              <span className="truncate">{title}</span>
            </button>
          ) : (
            title
          )}
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
        {aside ? (
          <div className="flex min-w-0 items-center gap-2 text-xs">{aside}</div>
        ) : null}
        {labelledTotals?.map((total) => (
          <span
            key={total.columnId}
            className="inline-flex shrink-0 items-center gap-1 text-xs"
          >
            <span className="text-muted-foreground">{total.label}</span>
            {total.node}
          </span>
        ))}
      </div>
      {onFilter || onHide || actions ? (
        <div className="sticky right-2 z-10 ml-auto flex items-center gap-0.5 bg-card md:bg-muted">
          {onFilter ? (
            <button type="button" onClick={onFilter} className={ACTION_CLASS}>
              <FunnelIcon aria-hidden className="size-3.5" />
              Filter to this
              <span className="sr-only">: {title}</span>
            </button>
          ) : null}
          {onHide ? (
            <button type="button" onClick={onHide} className={ACTION_CLASS}>
              <EyeSlashIcon aria-hidden className="size-3.5" />
              Hide
              <span className="sr-only">: {title}</span>
            </button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

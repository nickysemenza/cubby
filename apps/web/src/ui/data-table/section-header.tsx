import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The header's fixed height in px, border included (`h-8`). The desktop
 * virtualizer budgets this size without measuring, so the band must not grow.
 */
export const SECTION_HEADER_HEIGHT = 32;

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
  className,
}: SectionHeaderProps) {
  return (
    <div
      data-slot="list-section-header"
      style={{ paddingInlineStart: `${8 + depth * 12}px` }}
      className={cn(
        "group/section flex h-11 items-center gap-2 border-b border-hairline-soft bg-card px-2 md:h-8",
        className,
      )}
    >
      <h3 aria-label={title} className="min-w-0 truncate text-sm font-medium">
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
            className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
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
      {onFilter || onHide || actions ? (
        <div className="ml-auto flex items-center gap-0.5">
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

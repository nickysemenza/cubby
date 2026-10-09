import { useState, type ReactNode } from "react";

import type { ReferenceItem } from "~/entity/entity-references";
import { Button } from "~/ui/primitives/button";

/** A declaration bounds dense multi-reference cells without hiding the remaining records. */
export function ReferencePreview({
  items,
  limit,
  renderItem,
  singleLine = false,
  trailing,
}: {
  items: readonly ReferenceItem[];
  limit: number | null;
  renderItem: (item: ReferenceItem) => ReactNode;
  /**
   * Table rows have a fixed height: keep every chip on one line and show the
   * remainder as a count instead of an expander that would grow the row.
   */
  singleLine?: boolean;
  /** Rendered after the chips, on the same line (e.g. a "View all" link). */
  trailing?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded || limit === null ? items : items.slice(0, limit);
  const hidden = limit !== null ? items.length - limit : 0;
  if (singleLine)
    return (
      <span className="flex max-w-full min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap">
        {visible.map((item) => (
          <span key={item.id} className="flex min-w-0 shrink">
            {renderItem(item)}
          </span>
        ))}
        {hidden > 0 && (
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title={items
              .slice(limit!)
              .map((item) => item.name ?? item.id)
              .join(", ")}
          >
            +{hidden} more
          </span>
        )}
        {trailing && <span className="shrink-0">{trailing}</span>}
      </span>
    );
  return (
    <span className="flex max-w-full min-w-0 flex-wrap gap-x-2 gap-y-0.5">
      {visible.map((item) => (
        <span key={item.id} className="flex max-w-full min-w-0">
          {renderItem(item)}
        </span>
      ))}
      {limit !== null && items.length > limit && (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show less" : `+${items.length - limit} more`}
        </Button>
      )}
    </span>
  );
}

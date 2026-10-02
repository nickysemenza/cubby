import { useState, type ReactNode } from "react";

import type { ReferenceItem } from "~/entity/entity-references";
import { Button } from "~/ui/primitives/button";

/** A declaration bounds dense multi-reference cells without hiding the remaining records. */
export function ReferencePreview({
  items,
  limit,
  renderItem,
}: {
  items: readonly ReferenceItem[];
  limit: number | null;
  renderItem: (item: ReferenceItem) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded || limit === null ? items : items.slice(0, limit);
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

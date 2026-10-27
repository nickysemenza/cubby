import type { ResolvedListItem } from "@cubby/schemas/field-resolution";
import { Fragment, type ReactNode } from "react";

import { InheritedMarker } from "~/entity/fields/field-resolution";
import { cn } from "~/lib/utils";

/** Shared rendering for a resolved set, retaining each record and inherited marker. */
export function ResolvedListValue({
  items,
  renderReference,
}: {
  items: readonly ResolvedListItem[];
  renderReference: (
    ref: NonNullable<ResolvedListItem["ref"]>,
    label: string,
  ) => ReactNode;
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center overflow-hidden whitespace-pre">
      {items.map((item, index) => (
        <Fragment key={item.ref?.entityId ?? item.label}>
          {index > 0 ? <span aria-hidden="true">, </span> : null}
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1",
              item.inherited && "text-muted-foreground",
            )}
          >
            {item.inherited ? <InheritedMarker /> : null}
            {item.ref ? (
              renderReference(item.ref, item.label)
            ) : (
              <span className="truncate">{item.label}</span>
            )}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

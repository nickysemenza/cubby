import { formatDistanceToNow } from "date-fns";
import { Calendar } from "lucide-react";
import type { ReactNode } from "react";
import { EntityIcon } from "~/entities/entities";

/** `by {manufacturer}` — the standard product-card subtitle. */
export function byManufacturer(manufacturer: string): string {
  return `by ${manufacturer}`;
}

/** Muted "Created N ago" detail row, keyed for use in a `details` array. */
export function createdAgoDetail(createdAt: Date | string | number): ReactNode {
  return (
    <div
      key="created"
      className="flex items-center gap-1 text-muted-foreground text-sm"
    >
      <Calendar className="h-3 w-3" />
      Created {formatDistanceToNow(createdAt)} ago
    </div>
  );
}

/** Muted location detail row with the location entity icon. */
export function locationDetail(name: string): ReactNode {
  return (
    <div
      key="location"
      className="flex items-center gap-2 text-muted-foreground text-sm"
    >
      <EntityIcon entity="location" colored className="h-3 w-3" />
      {name}
    </div>
  );
}

/** Inline monospace chip used for UPCs and raw amounts in badge rows. */
export function CodeChip({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-2 py-1 text-sm">{children}</code>;
}

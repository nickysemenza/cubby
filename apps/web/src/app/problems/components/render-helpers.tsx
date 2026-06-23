import { formatDistanceToNow } from "date-fns";
import { Calendar } from "lucide-react";
import type { ReactNode } from "react";

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
/** Inline monospace chip used for UPCs and raw amounts in badge rows. */
export function CodeChip({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-2 py-1 text-sm">{children}</code>;
}

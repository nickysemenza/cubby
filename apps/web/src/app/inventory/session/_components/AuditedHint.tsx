import { format } from "date-fns";
import { formatCompactRelative } from "~/app/_components/HoverableTimestamp";
import { cn } from "~/lib/utils";

/**
 * Inline recency hint for a location's last audit (`lastBulkInventory`):
 * `audited 3d` / `never audited`, tinted `warning` once it's gone stale (>30d)
 * so the oldest bins stand out. Full timestamp on hover via the title attr
 * (safe inside the list-row button, unlike a Tooltip trigger).
 */
export function AuditedHint({
  at,
  className,
  label = "audited",
}: {
  at: Date | null;
  className?: string;
  label?: string;
}) {
  if (!at) {
    return (
      <span className={cn("text-muted-foreground", className)}>
        never {label}
      </span>
    );
  }
  const stale = Date.now() - at.getTime() > 30 * 86_400_000;
  return (
    <span
      title={`Last ${label} ${format(at, "yyyy-MM-dd HH:mm")}`}
      className={cn(
        stale ? "text-warning" : "text-muted-foreground",
        className,
      )}
    >
      {label} {formatCompactRelative(at)}
    </span>
  );
}

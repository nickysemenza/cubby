import { format } from "date-fns";
import { formatCompactRelative } from "~/app/_components/HoverableTimestamp";
import { cn } from "~/lib/utils";

/**
 * How long a count is allowed to speak in the present tense.
 *
 * Arbitrary, and deliberately so — nothing about a shelf makes 30 days the
 * true half-life of a number. It is the same threshold the location tint has
 * always used, kept in one place so the entry-level and location-level hints
 * cannot drift apart. Past it we stop reporting a relative age, which reads as
 * "recently true", and start naming the date it was last observed.
 */
const FRESHNESS_MS = 30 * 86_400_000;

/**
 * Inline recency hint for an audit timestamp — a location's `lastBulkInventory`
 * or an entry's `verifiedAt`.
 *
 * Three states, because a count is a claim with an expiry:
 *   - fresh    → `audited 3d`, muted
 *   - stale    → `unverified since Mar 2026`, warning-tinted. Deliberately NOT
 *                a relative age: "audited 412d" still implies the number is
 *                approximately current, and past the horizon we don't know that.
 *   - never    → `never audited`
 *
 * `placement="installed"` opts out of all of it. A fixture's count does not
 * rot — the dimmer in the wall is still one dimmer — so a staleness warning on
 * one would be a lie, and it can never be cleared because a recount does not
 * offer fixtures in the first place.
 *
 * Full timestamp on hover via `title` (safe inside a list-row button, unlike a
 * Tooltip trigger).
 */
export function AuditedHint({
  at,
  className,
  label = "audited",
  placement,
}: {
  at: Date | null;
  className?: string;
  label?: string;
  placement?: "stock" | "installed";
}) {
  if (placement === "installed") {
    return (
      <span
        title="A fixed installation — not counted during a recount, so it carries no verification age."
        className={cn("text-muted-foreground", className)}
      >
        installed
      </span>
    );
  }
  if (!at) {
    return (
      <span className={cn("text-muted-foreground", className)}>
        never {label}
      </span>
    );
  }
  const stale = Date.now() - at.getTime() > FRESHNESS_MS;
  return (
    <span
      title={`Last ${label} ${format(at, "yyyy-MM-dd HH:mm")}`}
      className={cn(
        stale ? "text-warning-ink" : "text-muted-foreground",
        className,
      )}
    >
      {stale
        ? `unverified since ${format(at, "MMM yyyy")}`
        : `${label} ${formatCompactRelative(at)}`}
    </span>
  );
}

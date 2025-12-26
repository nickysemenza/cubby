/**
 * ValueChange - displays a "from → to" change with red/green styling
 *
 * Used for showing field changes in:
 * - Audit log entries
 * - Google Sheets sync preview
 * - CSV import preview
 */

import { cn } from "~/lib/utils";

interface ValueChangeProps {
  from: unknown;
  to: unknown;
  /** Optional field label to display before the values */
  label?: string;
  /** Show "Sheet → App" labels for sync context */
  showSyncLabels?: boolean;
  /** Which side is selected/will be applied - dims the other side */
  selectedSide?: "from" | "to";
  /** Size variant */
  size?: "sm" | "md";
  /** Whether to show strikethrough on the "from" value */
  strikethrough?: boolean;
  className?: string;
}

function formatValue(value: unknown, maxLength = 500): string {
  if (value === null || value === undefined || value === "") {
    return "(empty)";
  }
  let str: string;
  if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  // Truncate long values
  if (str.length > maxLength) {
    return `${str.slice(0, maxLength)}...`;
  }
  return str;
}

export function ValueChange({
  from,
  to,
  label,
  showSyncLabels,
  selectedSide,
  size = "sm",
  strikethrough = true,
  className,
}: ValueChangeProps) {
  const sizeClasses = {
    sm: "text-xs",
    md: "text-sm",
  };

  // When a side is selected, dim the other side
  const fromDimmed = selectedSide === "to";
  const toDimmed = selectedSide === "from";

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {label && (
        <span
          className={cn("font-medium text-muted-foreground", sizeClasses[size])}
        >
          {label}:
        </span>
      )}
      {showSyncLabels && (
        <span
          className={cn(
            "font-medium",
            sizeClasses[size],
            fromDimmed ? "text-muted-foreground/50" : "text-muted-foreground",
          )}
        >
          Sheet:
        </span>
      )}
      <span
        className={cn(
          strikethrough && "line-through",
          sizeClasses[size],
          fromDimmed
            ? "text-red-400/40 dark:text-red-400/30"
            : "text-red-600 dark:text-red-400",
        )}
      >
        {formatValue(from)}
      </span>
      <span className={cn("text-muted-foreground", sizeClasses[size])}>→</span>
      {showSyncLabels && (
        <span
          className={cn(
            "font-medium",
            sizeClasses[size],
            toDimmed ? "text-muted-foreground/50" : "text-muted-foreground",
          )}
        >
          App:
        </span>
      )}
      <span
        className={cn(
          sizeClasses[size],
          toDimmed
            ? "text-green-400/40 dark:text-green-400/30"
            : "text-green-600 dark:text-green-400",
        )}
      >
        {formatValue(to)}
      </span>
    </span>
  );
}

/**
 * ChangesList - displays multiple field changes in a compact list
 */
interface ChangesListProps {
  changes: Record<string, { from: unknown; to: unknown }>;
  className?: string;
}

export function ChangesList({ changes, className }: ChangesListProps) {
  return (
    <div className={cn("space-y-1", className)}>
      {Object.entries(changes).map(([field, { from, to }]) => (
        <div key={field} className="flex gap-2">
          <ValueChange from={from} to={to} label={field} />
        </div>
      ))}
    </div>
  );
}

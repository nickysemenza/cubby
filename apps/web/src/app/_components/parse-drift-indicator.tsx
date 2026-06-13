import { AlertCircle } from "lucide-react";
import { cn } from "~/lib/utils";
import { InlineTextDiff } from "./inline-text-diff";

/**
 * One parser-drift axis, rendered identically everywhere it appears (ingredient detail
 * table, recipe editor, problems panel): an inline before→after word diff prefixed with
 * the ⚠ icon for cost-relevant axes (name, amount), or muted and icon-less for the
 * cosmetic modifier axis. Severity is the icon — the diff color means added/removed.
 *
 * Surfaces own their own *layout* (which column / title vs details); this owns the
 * *look* of a single indicator so the three can't drift apart.
 */
export function DriftIndicator({
  before,
  after,
  tone = "cost",
  className,
}: {
  before: string;
  after: string;
  tone?: "cost" | "muted";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        tone === "muted" && "text-muted-foreground/60",
        className,
      )}
    >
      {tone === "cost" && (
        <AlertCircle className="h-3 w-3 shrink-0 text-amber-600" />
      )}
      <InlineTextDiff before={before} after={after} />
    </span>
  );
}

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A slightly-rotated rubber-stamp label — the ledger flourish from the design
 * mockups. Use sparingly (at most one per surface) for states worth stamping:
 * empty ledgers, alerts, statuses. Mono, uppercase, bordered, tilted.
 */
export function InkStamp({
  children,
  tone = "ink",
  className,
}: {
  children: ReactNode;
  /** ink = muted eyebrow tone (default), red = alert, green = positive */
  tone?: "ink" | "red" | "green";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block -rotate-2 rounded-none border-[1.5px] px-2 py-0.5 font-mono font-semibold text-2xs uppercase tracking-wider",
        tone === "red" && "border-destructive/70 text-destructive",
        tone === "green" && "border-positive/70 text-positive",
        tone === "ink" && "border-eyebrow/70 text-eyebrow",
        className,
      )}
    >
      {children}
    </span>
  );
}

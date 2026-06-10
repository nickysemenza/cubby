import { Scissors } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * Perforated "tear here" divider between major page zones — a ledger-receipt
 * flourish. Use sparingly: at most one per page, between zones that genuinely
 * change register (e.g. content → history).
 */
export function TicketDivider({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex items-center gap-2 py-1", className)}
    >
      <span className="h-2.5 w-2.5 shrink-0 -ml-1 rounded-full border-2 border-foreground/25 border-t-transparent border-l-transparent rotate-45 bg-background" />
      <span className="flex-1 border-foreground/25 border-t-2 border-dashed" />
      <Scissors className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <span className="flex-1 border-foreground/25 border-t-2 border-dashed" />
      <span className="h-2.5 w-2.5 shrink-0 -mr-1 rounded-full border-2 border-foreground/25 border-r-transparent border-b-transparent rotate-45 bg-background" />
    </div>
  );
}

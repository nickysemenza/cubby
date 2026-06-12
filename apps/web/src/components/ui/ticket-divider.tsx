import { cn } from "~/lib/utils";

/**
 * Divider between major page zones — simplified (2026-06-12) to a single
 * hairline dashed rule, no scissors or perforations. Use sparingly: at most
 * one per page, between zones that genuinely change register (e.g. content →
 * history).
 */
export function TicketDivider({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("border-foreground/15 border-t border-dashed py-1", className)}
    />
  );
}

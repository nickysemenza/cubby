import type { AmountKind } from "@cubby/recipebridge";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { kindIconMap } from "./kind-icons";

/**
 * A single lit/dim kind-icon with a tooltip + sr-only label. Shared by the
 * coverage-chip row (ConversionCapabilities) and the per-row leading marker
 * (UnitMappingsTable's KindAccent). Lit = the kind participates in a working
 * conversion; dim = no conversion.
 */
export function KindIcon({
  kind,
  lit,
  className,
}: {
  kind: AmountKind;
  lit: boolean;
  /** Extra classes for the tooltip-trigger span (positioning/padding). */
  className?: string;
}) {
  const { Icon, label } = kindIconMap[kind]!;
  const state = lit ? "convertible" : "no conversion";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("inline-flex shrink-0", className)} />}
      >
        <span className="sr-only">{`${label}: ${state}`}</span>
        <Icon
          className={`size-3.5 ${lit ? "text-foreground" : "text-muted-foreground/40"}`}
          aria-hidden
        />
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{`${label}: ${state}`}</TooltipContent>
    </Tooltip>
  );
}

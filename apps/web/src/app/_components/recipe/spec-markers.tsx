/**
 * Shared inline markers for the recipe spec surfaces (RecipeSpecView and
 * RecipePrepSheetView). These small pill/badge/label
 * spans were duplicated verbatim across the three views; extracting them keeps
 * the engineering-view chrome visually consistent. Mirrors the EstimateMarker
 * pattern (plain styled <span>, no behavior).
 *
 * Each component merges an optional `className` via cn and keeps its layout
 * defaults (the ml-2 / align-middle nudge) so call sites stay declarative.
 */
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Numbered circle marking a method step. */
export const StepNumberBadge = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <span
    className={cn(
      "mt-px inline-flex size-[16px] shrink-0 items-center justify-center rounded-full border border-[var(--border)] font-mono text-2xs text-muted-foreground tabular-nums",
      className,
    )}
  >
    {children}
  </span>
);

/** "100% base" pill on the row chosen as a node's scaling base. */
export const BasePill = ({ className }: { className?: string }) => (
  <span
    className={cn(
      "ml-2 rounded-sm bg-primary/10 px-1 py-px align-middle font-mono text-2xs text-primary uppercase tracking-wide",
      className,
    )}
  >
    100% base
  </span>
);

/** "no weight" warning pill for an ingredient row missing a gram weight. */
export const NoWeightPill = ({ className }: { className?: string }) => (
  <span
    className={cn(
      "ml-2 rounded-sm bg-warning/15 px-1 py-px align-middle font-mono text-2xs text-warning uppercase tracking-wide",
      className,
    )}
  >
    no weight
  </span>
);

/** "↑ see above" pointer for a collapsed sub-recipe row (expanded elsewhere). */
export const SeeAbovePointer = ({ className }: { className?: string }) => (
  <span
    className={cn(
      "ml-2 align-middle font-mono text-2xs text-muted-foreground lowercase",
      className,
    )}
  >
    ↑ see above
  </span>
);

/** Warning label for a stub row (cycle / missing sub-recipe). */
export const StubWarning = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <span
    className={cn(
      "font-mono text-2xs text-warning uppercase tracking-wide",
      className,
    )}
  >
    {children}
  </span>
);

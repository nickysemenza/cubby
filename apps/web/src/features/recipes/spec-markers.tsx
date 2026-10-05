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
import { match } from "ts-pattern";

import {
  EntityRefLink,
  dottedEntityLink,
} from "~/entity/components/entity-ref-link";
import { cn } from "~/lib/utils";

import { type RecipeTreeRow, recipeTreeDisplayImage } from "./recipe-tree";

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
      "ml-2 rounded-sm bg-primary/10 px-1 py-px align-middle font-mono text-2xs tracking-wide text-primary uppercase",
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
      "ml-2 rounded-sm bg-warning/15 px-1 py-px align-middle font-mono text-2xs tracking-wide text-warning-ink uppercase",
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
      "font-mono text-2xs tracking-wide text-warning-ink uppercase",
      className,
    )}
  >
    {children}
  </span>
);

/**
 * The entity a tree row links to: ingredient leaves → their ingredient,
 * sub-recipe rows → their child recipe. Stub rows (cycle/missing) have no
 * target and render as plain text.
 */
const entityRefForRow = (
  row: RecipeTreeRow,
): { entity: "recipe" | "ingredient"; id: string } | null =>
  match(row)
    .with({ kind: "subrecipe" }, (r) => ({
      entity: "recipe" as const,
      id: r.child.recipe.id,
    }))
    .with({ kind: "ingredient" }, (r) =>
      r.row.type === "ingredient"
        ? { entity: "ingredient" as const, id: r.row.ingredient.id }
        : null,
    )
    .with({ kind: "stub" }, () => null)
    .exhaustive();

/** A tree row's name, linked with a hover preview when it has a target. */
export function TreeRowNameLink({
  row,
  name,
}: {
  row: RecipeTreeRow;
  name: string;
}) {
  const ref = entityRefForRow(row);
  if (!ref) return name;
  return (
    <EntityRefLink
      variant="preview"
      displayImage={
        row.kind === "subrecipe"
          ? recipeTreeDisplayImage(row.child.recipe)
          : null
      }
      entity={ref.entity}
      id={ref.id}
      className={dottedEntityLink}
    >
      {name}
    </EntityRefLink>
  );
}

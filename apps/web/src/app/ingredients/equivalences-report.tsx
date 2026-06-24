import type { CandidateEquivalence } from "@cubby/schemas/equivalences";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { EntityPillLink } from "../_components/EntityPill";

// Format a ratio compactly: a few significant figures, no trailing noise.
const fmtRatio = (n: number): string =>
  n.toLocaleString(undefined, { maximumSignificantDigits: 3 });

// "1 cup ≈ 127 g". medianRatio is always unitB per 1 unitA.
const equivalenceLabel = (c: CandidateEquivalence): string =>
  `1 ${c.unitA} ≈ ${fmtRatio(c.medianRatio)} ${c.unitB}`;

// The agreement signal: how far the loosest observation strays from the tightest,
// as a ×factor. 1.0× = every recipe agreed exactly; higher = more disagreement.
const spreadLabel = (c: CandidateEquivalence): string => {
  const { min, max } = c.ratioSpread;
  if (min <= 0 || max === min) return "exact";
  return `${(max / min).toLocaleString(undefined, { maximumSignificantDigits: 2 })}×`;
};

/**
 * Read-only report of candidate unit equivalences harvested from recipe lines that
 * carry a parenthetical secondary measure (e.g. "1 bunch kale (about 5 cups)" →
 * "1 bunch ≈ 5 cups" for kale). These are ingredient-scoped facts the conversion
 * engine can't derive on its own (cross-dimension: density / count / package
 * ratios). Runs automatically on load (with a Rescan button); rows are grouped by
 * ingredient. Surfacing only for now; promoting a candidate into a live conversion
 * edge is a follow-up (it needs an ingredient-level mapping store).
 */
export function EquivalencesReport() {
  const api = useTRPC();
  const { data, isFetching, error, refetch } = useQuery({
    ...api.recipe.harvestEquivalences.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  // Group candidates by ingredient (preserving the server's confidence order, so
  // the highest-signal ingredient leads and its rows stay contiguous).
  const groups = useMemo(() => {
    const byIngredient = new Map<string, CandidateEquivalence[]>();
    for (const c of data?.candidates ?? []) {
      const arr = byIngredient.get(c.ingredientId);
      if (arr) arr.push(c);
      else byIngredient.set(c.ingredientId, [c]);
    }
    return [...byIngredient.values()];
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          {isFetching ? "Scanning…" : "Rescan"}
        </Button>
        {data &&
          (() => {
            const flagged = data.candidates.filter(
              (c) => c.existingRatio != null,
            ).length;
            const novel = data.candidates.length - flagged;
            return (
              <span className="text-muted-foreground text-sm">
                {novel} novel
                {flagged > 0 && ` · ${flagged} flagged (differ from existing)`}
                {data.hiddenCovered > 0 &&
                  ` · ${data.hiddenCovered} hidden (already convertible)`}
              </span>
            );
          })()}
      </div>

      {error && (
        <p className="text-destructive text-sm">Scan failed: {error.message}</p>
      )}

      {isFetching && !data && (
        <p className="text-muted-foreground text-sm">Scanning recipes…</p>
      )}

      {data && data.candidates.length === 0 && !isFetching && (
        <p className="text-muted-foreground text-sm">
          No novel equivalences found — every harvested pair is either a
          same-dimension conversion or already covered by an existing mapping.
        </p>
      )}

      {data && data.candidates.length > 0 && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-border/40 border-b text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Ingredient</th>
              <th className="py-1 pr-2 font-medium">Equivalence</th>
              <th className="py-1 pr-2 text-right font-medium">Seen</th>
              <th className="py-1 pr-2 font-medium">Spread</th>
              <th className="py-1 font-medium">Examples</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) =>
              group.map((c, idx) => (
                <tr
                  key={`${c.ingredientId} ${c.unitA} ${c.unitB}`}
                  className={cn(
                    "align-top",
                    // Border only at group boundaries, so an ingredient's rows
                    // read as one cluster.
                    idx === group.length - 1 && "border-border/40 border-b",
                  )}
                >
                  {idx === 0 && (
                    <td
                      rowSpan={group.length}
                      className="border-border/40 border-b py-1 pr-2 align-top"
                    >
                      <EntityPillLink
                        entity="ingredient"
                        data={{ id: c.ingredientId, name: c.ingredientName }}
                      />
                    </td>
                  )}
                  <td className="whitespace-nowrap py-1 pr-2 font-medium">
                    <span className="inline-flex items-center gap-1">
                      {equivalenceLabel(c)}
                      {c.existingRatio != null && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="inline-flex text-warning" />
                            }
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Existing mapping converts 1 {c.unitA} ≈{" "}
                            {fmtRatio(c.existingRatio)} {c.unitB}, but recipes
                            suggest {fmtRatio(c.medianRatio)} {c.unitB}.
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </td>
                  <td className="py-1 pr-2 text-right text-muted-foreground tabular-nums">
                    {c.occurrences}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2 text-muted-foreground">
                    {spreadLabel(c)}
                  </td>
                  <td className="py-1">
                    <ul className="space-y-1">
                      {c.examples.map((ex, i) => (
                        <li
                          key={`${ex.recipeId} ${i}`}
                          className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground/70"
                        >
                          <EntityPillLink
                            entity="recipe"
                            data={{ id: ex.recipeId, name: ex.recipeName }}
                            compact
                          />
                          {ex.rawLine && <span>· {ex.rawLine}</span>}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

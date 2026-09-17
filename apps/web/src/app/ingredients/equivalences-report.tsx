import type { CandidateEquivalence } from "@cubby/schemas/equivalences";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useMemo } from "react";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { recipe } from "~/app/recipes/recipe.functions";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { StatusText } from "~/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { useHydrated } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";

import { EntityInlineLink } from "../_components/EntityInlineLink";
import { equivalenceWorkbenchSearch } from "./equivalence-workbench-link";

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
 * Report of candidate unit equivalences harvested from recipe lines that
 * carry a parenthetical secondary measure (e.g. "1 bunch kale (about 5 cups)" →
 * "1 bunch ≈ 5 cups" for kale). These are ingredient-scoped facts the conversion
 * engine can't derive on its own (cross-dimension: density / count / package
 * ratios). Runs automatically on load (with a Rescan button); rows are grouped by
 * ingredient. Each row opens the ingredient workbench with the proposed
 * conversion prefilled; the user still chooses the concrete Product whose
 * UnitMapping will store it and explicitly saves the write.
 */
export function EquivalencesReport() {
  const {
    data: harvest,
    isFetching: harvestFetching,
    error,
    refetch,
  } = useQuery({
    ...recipe.harvestEquivalences.queryOptions(),
  });
  // Hydration-stable: the server renders mid-scan with no candidates, while the
  // client's first render already has the streamed ones — so the scanning
  // notice, the button's `disabled`, and the summary all have to ignore the
  // data until hydration finishes. See useHydratedLoading.
  const hydrated = useHydrated();
  const data = hydrated ? harvest : undefined;
  const isFetching = !hydrated || harvestFetching;

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
  const imageRefs = useMemo(
    () =>
      groups.flatMap((group) => [
        ...group.map((candidate) => ({
          entityType: "ingredient" as const,
          entityId: candidate.ingredientId,
        })),
        ...group.flatMap((candidate) =>
          candidate.examples.map((example) => ({
            entityType: "recipe" as const,
            entityId: example.recipeId,
          })),
        ),
      ]),
    [groups],
  );
  const displayImages = useEntityDisplayImages(imageRefs);

  return (
    <Stack>
      <Row align="center" gap="sm">
        <Button
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
          {isFetching ? "Scanning…" : "Rescan"}
        </Button>
        {data &&
          (() => {
            const flagged = data.candidates.filter(
              (c) => c.existingRatio != null,
            ).length;
            const novel = data.candidates.length - flagged;
            return (
              <Description as="span">
                {novel} novel
                {flagged > 0 && ` · ${flagged} flagged (differ from existing)`}
                {data.hiddenCovered > 0 &&
                  ` · ${data.hiddenCovered} hidden (already convertible)`}
              </Description>
            );
          })()}
      </Row>

      {error && (
        <StatusText as="p" tone="destructive" className="text-sm">
          Scan failed: {error.message}
        </StatusText>
      )}

      {isFetching && !data && <Description>Scanning recipes…</Description>}

      {data && data.candidates.length === 0 && !isFetching && (
        <Description>
          No novel equivalences found — every harvested pair is either a
          same-dimension conversion or already covered by an existing mapping.
        </Description>
      )}

      {data && data.candidates.length > 0 && (
        <Table className="table-auto">
          <TableHeader>
            <TableRow>
              <TableHead>Ingredient</TableHead>
              <TableHead>Equivalence</TableHead>
              <TableHead className="text-right">Seen</TableHead>
              <TableHead>Spread</TableHead>
              <TableHead>Examples</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) =>
              group.map((c, idx) => (
                <TableRow
                  key={`${c.ingredientId} ${c.unitA} ${c.unitB}`}
                  // Border only at group boundaries, so an ingredient's rows
                  // read as one cluster.
                  className={cn(idx !== group.length - 1 && "border-b-0")}
                >
                  {idx === 0 && (
                    <TableCell
                      rowSpan={group.length}
                      className="border-b align-top"
                    >
                      <EntityInlineLink
                        displayImage={
                          displayImages[
                            entityDisplayImageKey({
                              entityType: "ingredient",
                              entityId: c.ingredientId,
                            })
                          ] ?? null
                        }
                        entity="ingredient"
                        data={{
                          id: c.ingredientId,
                          name: c.ingredientName,
                        }}
                      />
                    </TableCell>
                  )}
                  <TableCell className="align-top font-medium">
                    <span className="inline-flex items-center gap-1">
                      {equivalenceLabel(c)}
                      {c.existingRatio != null && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="inline-flex text-warning" />
                            }
                          >
                            <AlertTriangle className="size-3.5" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Existing mapping converts 1 {c.unitA} ≈{" "}
                            {fmtRatio(c.existingRatio)} {c.unitB}, but recipes
                            suggest {fmtRatio(c.medianRatio)} {c.unitB}.
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right align-top text-muted-foreground tabular-nums">
                    {c.occurrences}
                  </TableCell>
                  <TableCell className="align-top text-muted-foreground">
                    {spreadLabel(c)}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <Stack as="ul" gap="xs">
                      {c.examples.map((ex) => (
                        <li
                          key={`${ex.recipeId}-${ex.rawLine ?? ex.recipeName}`}
                          className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground"
                        >
                          <EntityInlineLink
                            displayImage={
                              displayImages[
                                entityDisplayImageKey({
                                  entityType: "recipe",
                                  entityId: ex.recipeId,
                                })
                              ] ?? null
                            }
                            entity="recipe"
                            data={{
                              id: ex.recipeId,
                              name: ex.recipeName,
                            }}
                            compact
                          />
                          {ex.rawLine && <span>· {ex.rawLine}</span>}
                        </li>
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell className="align-top">
                    <Button
                      variant="outline"
                      size="sm"
                      render={
                        <Link
                          to="/ingredients/workbench"
                          search={equivalenceWorkbenchSearch(c)}
                        />
                      }
                    >
                      {c.existingRatio == null ? "Review" : "Resolve conflict"}
                    </Button>
                  </TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}

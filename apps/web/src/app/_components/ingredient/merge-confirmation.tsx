import type { IngredientMergeCandidateImpact } from "@cubby/schemas/ingredient";
import { useQuery } from "@tanstack/react-query";
import { sortBy, sumBy } from "es-toolkit";
import { Check } from "lucide-react";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { EntityIcon } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { cn } from "~/lib/utils";
import { EntityInlineLink } from "../EntityInlineLink";

/** One count chip in a candidate row / the net-effect summary. */
function Stat({
  value,
  label,
  muted,
}: {
  value: number;
  label: string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "tabular-nums",
        muted && value === 0 && "text-muted-foreground",
      )}
    >
      <span className="font-medium">{value}</span> {label}
      {value === 1 ? "" : "s"}
    </span>
  );
}

/**
 * Rank candidates so the BEST keeper sorts first: a USDA-linked ingredient wins,
 * then more linked products, then more recipe usages, then more aliases. This is
 * the "worth keeping" order — the row that carries the most enrichment/usage
 * should absorb the others, not whichever was checked first.
 */
function rankImpact(
  impacts: IngredientMergeCandidateImpact[],
): IngredientMergeCandidateImpact[] {
  // sortBy is ascending; negate each key so the strongest candidate leads.
  return sortBy(impacts, [
    (i) => (i.hasUsdaLink ? 0 : 1),
    (i) => -i.productCount,
    (i) => -i.recipeUsageCount,
    (i) => -i.aliasCount,
  ]);
}

/**
 * Merge confirmation body. Holds its own selected-target state so the radios
 * re-render on click, and mirrors the choice into `targetRef` so a caller that
 * can't read this component's state (e.g. a bulk-action dialog's `onExecute`)
 * picks the right keeper. Shared by the ingredient list's bulk merge and the
 * ingredient-usage table's "merge?" affordance.
 *
 * Fetches a read-only merge preview (per-candidate recipe/product/alias counts +
 * USDA-linkability) so the picker can (a) default the keeper to the BEST
 * candidate rather than selection order and (b) show what each row carries and
 * what the chosen keeper will absorb — instead of a static "products move over"
 * sentence that hides the actual blast radius.
 */
export function MergeConfirmation({
  ingredients,
  targetRef,
}: {
  ingredients: Array<{ id: string; name: string }>;
  targetRef: RefObject<string | null>;
}) {
  const api = useTRPC();
  const ids = useMemo(() => ingredients.map((i) => i.id), [ingredients]);
  const { data: impacts } = useQuery(
    api.ingredient.mergeImpact.queryOptions({ ids }),
  );

  // Keyed by plain string: the `ingredients` prop ids are unbranded (they come
  // from bulk-selected rows), so widen the map key to match `.get(ing.id)`.
  const impactById = useMemo(
    () =>
      new Map<string, IngredientMergeCandidateImpact>(
        (impacts ?? []).map((i) => [i.id, i]),
      ),
    [impacts],
  );

  // Default keeper = best candidate once the preview loads, else selection order.
  // A ref (`userPicked`) keeps a manual choice from being clobbered when the
  // preview arrives and recomputes the default.
  const [targetId, setTargetId] = useState<string>(
    () => ingredients[0]?.id ?? "",
  );
  const [userPicked, setUserPicked] = useState(false);
  const bestId = useMemo(() => {
    if (!impacts || impacts.length === 0) return null;
    return rankImpact(impacts)[0]?.id ?? null;
  }, [impacts]);
  useEffect(() => {
    if (!userPicked && bestId) setTargetId(bestId);
  }, [bestId, userPicked]);
  useEffect(() => {
    targetRef.current = targetId;
  }, [targetId, targetRef]);

  const pick = (id: string) => {
    setUserPicked(true);
    setTargetId(id);
  };

  const aliases = ingredients.filter((i) => i.id !== targetId);

  // Net effect on the chosen keeper: sum the aliases' recipe/product/alias
  // counts (what folds in). The keeper's own existing aliases also count toward
  // the post-merge alias set, but the headline is "what will be absorbed".
  const absorbed = useMemo(() => {
    const rows = aliases
      .map((a) => impactById.get(a.id))
      .filter((i): i is IngredientMergeCandidateImpact => i != null);
    return {
      recipes: sumBy(rows, (r) => r.recipeUsageCount),
      products: sumBy(rows, (r) => r.productCount),
      // Each absorbed ingredient contributes its own name plus its aliases.
      aliases: sumBy(rows, (r) => r.aliasCount + 1),
    };
  }, [aliases, impactById]);

  return (
    <Stack>
      <div>
        <div className="mb-1 font-medium text-muted-foreground text-sm">
          Keep (target):
        </div>
        <div className="flex flex-col gap-1">
          {ingredients.map((ing) => {
            const selected = ing.id === targetId;
            const impact = impactById.get(ing.id);
            const isBest = ing.id === bestId;
            return (
              <Button
                key={ing.id}
                type="button"
                variant={selected ? "default" : "outline"}
                size="sm"
                className="h-auto justify-start py-1"
                onClick={() => pick(ing.id)}
              >
                <Check
                  className={cn(
                    "h-4 w-4 shrink-0",
                    selected ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <span className="flex items-center gap-1 truncate">
                    <span className="truncate">{ing.name}</span>
                    {impact?.hasUsdaLink && (
                      <EntityIcon
                        entity="usda-food"
                        size={12}
                        colored
                        className="shrink-0"
                        aria-label="Linked to USDA food data"
                      />
                    )}
                    {isBest && !selected && (
                      <Badge variant="outline" className="shrink-0">
                        Best
                      </Badge>
                    )}
                  </span>
                  {impact && (
                    <span
                      className={cn(
                        "flex flex-wrap gap-x-2 text-xs",
                        selected
                          ? "text-primary-foreground/80"
                          : "text-muted-foreground",
                      )}
                    >
                      <Stat value={impact.recipeUsageCount} label="recipe" />
                      <Stat value={impact.productCount} label="product" />
                      <Stat value={impact.aliasCount} label="alias" />
                    </span>
                  )}
                </span>
              </Button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="mb-1 font-medium text-muted-foreground text-sm">
          Merge into aliases:
        </div>
        <Row gap="xs" wrap>
          {aliases.length > 0 ? (
            aliases.map((a) => (
              <EntityInlineLink
                key={a.id}
                entity="ingredient"
                data={{ name: a.name, id: a.id }}
              />
            ))
          ) : (
            <NoneValue />
          )}
        </Row>
      </div>
      {impacts && aliases.length > 0 ? (
        <Description size="xs">
          The kept ingredient will absorb{" "}
          <Stat value={absorbed.recipes} label="recipe use" />,{" "}
          <Stat value={absorbed.products} label="product" />, and{" "}
          <Stat value={absorbed.aliases} label="alias" /> — the other selected
          ingredient{aliases.length === 1 ? "" : "s"} then{" "}
          {aliases.length === 1 ? "is" : "are"} deleted.
        </Description>
      ) : (
        <Description size="xs">
          The other selected ingredient{aliases.length === 1 ? "" : "s"} will be
          deleted — their names become aliases of the kept one, and their
          products and recipe uses move over.
        </Description>
      )}
    </Stack>
  );
}

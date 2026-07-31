import { sortBy } from "es-toolkit";
import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  OperationImpact,
  type PreviewOperationDraft,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { Row, Stack } from "~/components/layout";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { EntityInlineLink } from "../EntityInlineLink";

export interface IngredientMergePair {
  id: string;
  name: string;
}

/** One `{label, count}` chip in a candidate row. */
function DetailStat({ label, count }: { label: string; count: number }) {
  return (
    <span className="tabular-nums">
      <span className="font-medium">{count}</span> {label}
    </span>
  );
}

/**
 * Shared merge-confirm dialog for ingredients — the keeper picker plus the
 * live operation-impact preview. Used by the ingredient list's bulk merge,
 * the enrichment workbench, and the review queue so the three copies of this
 * modal (previously hand-rolled at each call site around a shared
 * `MergeConfirmation` body) can't drift.
 *
 * Two-phase preview, both via `previewOperation`:
 * 1. No `keepId` — the response's `candidates` rank each ingredient by
 *    `weight` (USDA link, then product/recipe/alias counts, descending) so
 *    the picker can default to the best keeper and show what each row
 *    carries.
 * 2. Once a keeper is known (by default or by hand), a second call WITH
 *    `keepId` gets the real impact, rendered via `OperationImpact`. Merge has
 *    no server-enforced blockers today, but the dialog still disables Confirm
 *    on `canProceed === false` like every other destructive surface — see
 *    `useOperationPreview`'s doc comment for the gating rule this follows.
 *
 * Does NOT own the merge mutation — each call site fires its own (with its
 * own toast/invalidate/error handling) via `onConfirm(keepId, aliasIds)`.
 */
export function IngredientMergeDialog({
  ingredients,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  /** The full set under consideration — at least 2 for a merge to make sense. */
  ingredients: IngredientMergePair[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires once, with the chosen keeper and the alias ids being merged into it. */
  onConfirm: (keepId: string, aliasIds: string[]) => void;
  isPending: boolean;
}) {
  const ids = useMemo(() => ingredients.map((i) => i.id), [ingredients]);

  // Phase 1: rank candidates (no keepId) to default the keeper.
  const rankInput = useMemo<PreviewOperationDraft | null>(
    () =>
      ids.length >= 2
        ? { operation: "merge", entity: "ingredient", mergeIds: ids }
        : null,
    [ids],
  );
  const rankPreview = useOperationPreview(rankInput, open);
  const candidatesById = useMemo(
    () => new Map((rankPreview.data?.candidates ?? []).map((c) => [c.id, c])),
    [rankPreview.data],
  );
  const bestId = useMemo(() => {
    const candidates = rankPreview.data?.candidates;
    if (!candidates || candidates.length === 0) return null;
    return sortBy(candidates, [(c) => -c.weight])[0]?.id ?? null;
  }, [rankPreview.data]);

  // Default keeper = best candidate once ranked, else selection order. A
  // manual pick (`userPicked`) must never be clobbered by a later-arriving
  // ranked preview recomputing the default.
  const [keepId, setKeepId] = useState<string | null>(null);
  const [userPicked, setUserPicked] = useState(false);
  useEffect(() => {
    if (!userPicked && bestId) setKeepId(bestId);
  }, [bestId, userPicked]);
  // Fresh picker state each time the dialog opens for a (possibly different)
  // set of ingredients.
  useEffect(() => {
    if (!open) {
      setKeepId(null);
      setUserPicked(false);
    }
  }, [open]);
  const pick = (id: string) => {
    setUserPicked(true);
    setKeepId(id);
  };

  const effectiveKeepId = keepId ?? ingredients[0]?.id ?? null;
  const aliases = ingredients.filter((i) => i.id !== effectiveKeepId);
  const aliasIds = useMemo(() => aliases.map((a) => a.id), [aliases]);

  // Phase 2: the real preview, once a keeper is known.
  const previewInput = useMemo<PreviewOperationDraft | null>(
    () =>
      effectiveKeepId && aliasIds.length > 0
        ? {
            operation: "merge",
            entity: "ingredient",
            keepId: effectiveKeepId,
            mergeIds: aliasIds,
          }
        : null,
    [effectiveKeepId, aliasIds],
  );
  const preview = useOperationPreview(previewInput, open);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Merge ingredients?</AlertDialogTitle>
        </AlertDialogHeader>
        <Stack>
          <div>
            <div className="mb-1 font-medium text-muted-foreground text-sm">
              Keep (target):
            </div>
            <div className="flex flex-col gap-1">
              {ingredients.map((ing) => {
                const selected = ing.id === effectiveKeepId;
                const candidate = candidatesById.get(ing.id);
                const usdaLinked =
                  candidate?.detail.some(
                    (d) => d.label === "USDA link" && d.count > 0,
                  ) ?? false;
                const otherDetail =
                  candidate?.detail.filter((d) => d.label !== "USDA link") ??
                  [];
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
                        "size-4 shrink-0",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="flex items-center gap-1 truncate">
                        <span className="truncate">{ing.name}</span>
                        {usdaLinked && (
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
                      {otherDetail.length > 0 && (
                        <span
                          className={cn(
                            "flex flex-wrap gap-x-2 text-xs",
                            selected
                              ? "text-primary-foreground/80"
                              : "text-muted-foreground",
                          )}
                        >
                          {otherDetail.map((d) => (
                            <DetailStat
                              key={d.label}
                              label={d.label}
                              count={d.count}
                            />
                          ))}
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
          <OperationImpact
            preview={preview.data}
            isLoading={preview.isLoading}
            isError={preview.isError}
            onRetry={() => void preview.refetch()}
          />
        </Stack>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            disabled={
              isPending ||
              !effectiveKeepId ||
              aliasIds.length === 0 ||
              preview.data?.canProceed === false
            }
            onClick={() => {
              if (effectiveKeepId) onConfirm(effectiveKeepId, aliasIds);
            }}
          >
            {isPending ? "Merging…" : "Merge"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

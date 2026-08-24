import type { PreviewMergeEntity } from "@cubby/schemas/entity-integrity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";
import { sortBy } from "es-toolkit";
import { Check } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  OperationImpact,
  type PreviewOperationDraft,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { entities } from "~/entities/entities";
import type { EntityDefinition, MergeableConfig } from "~/entities/types";
import { useTRPC } from "~/integrations/trpc/react";
import { cn } from "~/lib/utils";

/** Display text comes from `mergeable.rowLabel`/`rowStat`, not a hardcoded
 * `name` field — a row shape like `PurchaseOut` (no `name`) works here too. */
interface MergeRow {
  id: string;
}

const resolveCopyText = (
  value: ReactNode | ((keeperLabel: ReactNode) => ReactNode) | undefined,
  keeperLabel: ReactNode,
): ReactNode => (typeof value === "function" ? value(keeperLabel) : value);

/** Cancel/Confirm footer shared by both keeper modes. */
function MergeDialogFooter({
  disabled,
  isPending,
  label,
  onCancel,
  onConfirm,
}: {
  disabled: boolean;
  isPending: boolean;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button disabled={disabled} onClick={onConfirm}>
        {isPending ? "Merging…" : label}
      </Button>
    </DialogFooter>
  );
}

/**
 * Shared merge-confirm dialog: the keeper picker (or fixed-keeper candidate
 * list) plus the live `entityIntegrity.previewOperation` impact preview,
 * Confirm gated on `preview.data?.canProceed === false` (see
 * `useOperationPreview`'s doc comment). Behavior is driven entirely by the
 * calling entity's `mergeable` config in `~/entities/entities.tsx` — see
 * `MergeableConfig`'s doc comment for the two keeper strategies.
 *
 * Does NOT own the merge mutation — the caller fires its own via
 * `onConfirm(keepId, aliasIds)`.
 */
export function EntityMergeDialog<T extends MergeRow>({
  entity,
  open,
  onOpenChange,
  onConfirm,
  isPending,
  rows,
  keeper,
}: {
  entity: BrowserRoutedEntity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires once, with the chosen keeper and the alias ids being merged into it. */
  onConfirm: (keepId: string, aliasIds: string[]) => void;
  isPending: boolean;
  /** Ranked mode: the full set under consideration (>= 2). Ignored in fixed mode. */
  rows?: T[];
  /** Fixed mode: the anchor row that stays the keeper. Ignored in ranked mode. */
  keeper?: T;
}) {
  // Widened: `entities[entity]` is a union of 16 per-entity literal shapes and
  // only some declare `mergeable`, so a direct read doesn't compile even
  // though every member satisfies `EntityDefinition` (see `mcpEntityPlural`'s
  // comment in entity-manifest.ts for the same pattern).
  const config = (entities[entity] as EntityDefinition).mergeable;
  if (!config) return null;
  const previewEntity: PreviewMergeEntity =
    config.previewEntity ?? (entity as PreviewMergeEntity);

  if (config.keeperMode === "fixed") {
    if (!keeper) return null;
    return (
      <FixedMergeDialog
        entity={previewEntity}
        config={config}
        keeper={keeper}
        open={open}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        isPending={isPending}
      />
    );
  }

  return (
    <RankedMergeDialog
      entity={previewEntity}
      config={config}
      rows={rows ?? []}
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      isPending={isPending}
    />
  );
}

/**
 * "ranked" keeperMode: the picker is a toggle-button list over `rows`, defaulted
 * to the server's best-weighted candidate. Two-phase preview, both via
 * `previewOperation`: an unkeyed call ranks candidates to pick the default,
 * then a keyed call gets the real impact once a keeper is known (by default or
 * by hand).
 */
function RankedMergeDialog<T extends MergeRow>({
  entity,
  config,
  rows,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  entity: PreviewMergeEntity;
  config: MergeableConfig;
  rows: T[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (keepId: string, aliasIds: string[]) => void;
  isPending: boolean;
}) {
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);

  const rankInput = useMemo<PreviewOperationDraft | null>(
    () =>
      ids.length >= 2 ? { operation: "merge", entity, mergeIds: ids } : null,
    [ids, entity],
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

  // Default keeper = best candidate once ranked, else selection order. A manual
  // pick (`userPicked`) must never be clobbered by a later-arriving ranked
  // preview recomputing the default.
  const [keepId, setKeepId] = useState<string | null>(null);
  const [userPicked, setUserPicked] = useState(false);
  useEffect(() => {
    if (!userPicked && bestId) setKeepId(bestId);
  }, [bestId, userPicked]);
  // Fresh picker state each time the dialog opens for a (possibly different) set.
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

  const effectiveKeepId = keepId ?? rows[0]?.id ?? null;
  const aliases = rows.filter((r) => r.id !== effectiveKeepId);
  const aliasIds = useMemo(() => aliases.map((a) => a.id), [aliases]);

  const previewInput = useMemo<PreviewOperationDraft | null>(
    () =>
      effectiveKeepId && aliasIds.length > 0
        ? {
            operation: "merge",
            entity,
            keepId: effectiveKeepId,
            mergeIds: aliasIds,
          }
        : null,
    [entity, effectiveKeepId, aliasIds],
  );
  const preview = useOperationPreview(previewInput, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{resolveCopyText(config.copy.title, null)}</DialogTitle>
          {config.copy.description && (
            <DialogDescription>
              {resolveCopyText(config.copy.description, null)}
            </DialogDescription>
          )}
        </DialogHeader>
        <Stack>
          <div>
            <div className="mb-1 font-medium text-muted-foreground text-sm">
              Keep (target):
            </div>
            <div className="flex flex-col gap-1">
              {rows.map((row) => {
                const selected = row.id === effectiveKeepId;
                const candidate = candidatesById.get(row.id);
                const isBest = row.id === bestId;
                return (
                  <Button
                    key={row.id}
                    type="button"
                    variant={selected ? "default" : "outline"}
                    size="sm"
                    className="h-auto justify-start py-1"
                    onClick={() => pick(row.id)}
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="flex items-center gap-1 truncate">
                        {config.rowLabel(row, candidate)}
                        {isBest && !selected && (
                          <Badge variant="outline" className="shrink-0">
                            Best
                          </Badge>
                        )}
                      </span>
                      {config.rowStat && (
                        <span
                          className={cn(
                            "flex flex-wrap gap-x-2 text-xs",
                            selected
                              ? "text-primary-foreground/80"
                              : "text-muted-foreground",
                          )}
                        >
                          {config.rowStat(row, candidate)}
                        </span>
                      )}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
          {config.copy.caution && (
            <Description size="xs">{config.copy.caution}</Description>
          )}
          <OperationImpact
            preview={preview.data}
            isLoading={preview.isLoading}
            isError={preview.isError}
            onRetry={() => void preview.refetch()}
          />
        </Stack>
        <MergeDialogFooter
          disabled={
            isPending ||
            !effectiveKeepId ||
            aliasIds.length === 0 ||
            preview.data?.canProceed === false
          }
          isPending={isPending}
          label="Merge"
          onCancel={() => onOpenChange(false)}
          onConfirm={() => {
            if (effectiveKeepId) onConfirm(effectiveKeepId, aliasIds);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * "fixed" keeperMode: the keeper is already known (the record being viewed);
 * this fetches OTHER same-type rows via `config.candidateQuery` for the user to
 * fold in via checkboxes. No ranking preview — there's nothing to rank.
 */
function FixedMergeDialog<T extends MergeRow>({
  entity,
  config,
  keeper,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  entity: PreviewMergeEntity;
  config: MergeableConfig;
  keeper: T;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (keepId: string, aliasIds: string[]) => void;
  isPending: boolean;
}) {
  const api = useTRPC();
  const [selected, setSelected] = useState<string[]>([]);

  const candidatesQuery = useQuery({
    ...config.candidateQuery?.(api, keeper),
    enabled: open && !!config.candidateQuery,
  });
  const candidates = useMemo(
    () =>
      (
        (candidatesQuery.data as { items?: T[] } | undefined)?.items ?? []
      ).filter((row) => row.id !== keeper.id),
    [candidatesQuery.data, keeper.id],
  );

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );

  const previewInput = useMemo<PreviewOperationDraft | null>(
    () =>
      selected.length > 0
        ? { operation: "merge", entity, keepId: keeper.id, mergeIds: selected }
        : null,
    [entity, keeper.id, selected],
  );
  const preview = useOperationPreview(previewInput, open);

  const keeperLabel = config.rowLabel(keeper);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelected([]);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {resolveCopyText(config.copy.title, keeperLabel)}
          </DialogTitle>
          {config.copy.description && (
            <DialogDescription>
              {resolveCopyText(config.copy.description, keeperLabel)}
            </DialogDescription>
          )}
        </DialogHeader>

        {candidates.length === 0 ? (
          <Empty variant="minimal" className="py-6">
            <EmptyTitle>
              {config.copy.emptyTitle ?? "Nothing to merge"}
            </EmptyTitle>
            <EmptyDescription>
              {config.copy.emptyDescription ?? "No other rows are on file."}
            </EmptyDescription>
          </Empty>
        ) : (
          <Stack gap="xs" className="max-h-64 overflow-y-auto">
            {candidates.map((candidate) => (
              <Row
                key={candidate.id}
                align="center"
                gap="sm"
                className="min-w-0 border border-[var(--border)] px-2 py-1"
              >
                <Checkbox
                  checked={selected.includes(candidate.id)}
                  onCheckedChange={() => toggle(candidate.id)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {config.rowLabel(candidate)}
                </span>
                {config.rowStat && (
                  <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                    {config.rowStat(candidate)}
                  </span>
                )}
              </Row>
            ))}
          </Stack>
        )}

        {config.copy.caution && (
          <Description size="xs">{config.copy.caution}</Description>
        )}

        {selected.length > 0 && (
          <OperationImpact
            preview={preview.data}
            isLoading={preview.isLoading}
            isError={preview.isError}
            onRetry={() => void preview.refetch()}
          />
        )}

        <MergeDialogFooter
          disabled={
            selected.length === 0 ||
            isPending ||
            preview.data?.canProceed === false
          }
          isPending={isPending}
          label={`Merge ${selected.length || ""}`.trim()}
          onCancel={() => onOpenChange(false)}
          onConfirm={() => onConfirm(keeper.id, selected)}
        />
      </DialogContent>
    </Dialog>
  );
}

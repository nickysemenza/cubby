import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import {
  type ImpactPreviewOperations,
  MergeImpactPreview,
} from "~/app/_components/actions/entity-operation-impact-preview";
import { Row, Stack } from "~/components/layout";
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
import type { MergeDisplayRow, MergeableConfig } from "~/entities/types";

/** Display text comes from `mergeable.rowLabel`/`rowStat`, not a hardcoded
 * `name` field — a row shape like `PurchaseOut` (no `name`) works here too. */
type MergeRow = MergeDisplayRow;

const isCopyFactory = (
  value: ReactNode | ((keeperLabel: ReactNode) => ReactNode),
): value is (keeperLabel: ReactNode) => ReactNode =>
  typeof value === "function";

const resolveCopyText = (
  value: ReactNode | ((keeperLabel: ReactNode) => ReactNode) | undefined,
  keeperLabel: ReactNode,
): ReactNode => (isCopyFactory(value) ? value(keeperLabel) : value);

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
 * Shared merge-confirm dialog. The caller supplies a proposed group, and the
 * dialog deterministically starts with its first row as keeper; the picker is
 * still available when a person needs to choose a different survivor.
 *
 * Does NOT own the merge mutation — the caller fires its own via
 * `onConfirm(keepId, aliasIds)`. Real mutations remain the source of truth for
 * collision and workflow refusals.
 */
export function EntityMergeDialog<T extends MergeRow>({
  entity,
  open,
  onOpenChange,
  onConfirm,
  isPending,
  rows,
  keeper,
  initialAliasIds,
  impactPreviewOperations,
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
  /** Fixed mode: aliases already chosen by a canonical roster selection. */
  initialAliasIds?: string[];
  /** Test-injectable seam for the per-loser impact preview's `connections` query. */
  impactPreviewOperations?: ImpactPreviewOperations;
}) {
  const definition = entities[entity];
  if (!("mergeable" in definition)) return null;
  const config = definition.mergeable;
  if (!config) return null;

  if (config.keeperMode === "fixed") {
    if (!keeper) return null;
    return (
      <FixedMergeDialog
        config={config}
        keeper={keeper}
        initialAliasIds={initialAliasIds}
        open={open}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        isPending={isPending}
        impactPreviewOperations={impactPreviewOperations}
      />
    );
  }

  return (
    <RankedMergeDialog
      config={config}
      rows={rows ?? []}
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      isPending={isPending}
      impactPreviewOperations={impactPreviewOperations}
    />
  );
}

function RankedMergeDialog<T extends MergeRow>({
  config,
  rows,
  open,
  onOpenChange,
  onConfirm,
  isPending,
  impactPreviewOperations,
}: {
  config: MergeableConfig;
  rows: T[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (keepId: string, aliasIds: string[]) => void;
  isPending: boolean;
  impactPreviewOperations?: ImpactPreviewOperations;
}) {
  const [selectedKeepId, setSelectedKeepId] = useState<string | null>(null);
  const effectiveKeepId = rows.some((row) => row.id === selectedKeepId)
    ? selectedKeepId
    : (rows[0]?.id ?? null);
  const aliasIds = useMemo(
    () => rows.filter((row) => row.id !== effectiveKeepId).map((row) => row.id),
    [effectiveKeepId, rows],
  );

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
            <div className="mb-1 text-sm font-medium text-muted-foreground">
              Keep (target):
            </div>
            <div className="flex flex-col gap-1">
              {rows.map((row) => {
                const selected = row.id === effectiveKeepId;
                return (
                  <Button
                    key={row.id}
                    type="button"
                    variant={selected ? "default" : "outline"}
                    size="sm"
                    className="h-auto justify-start py-1"
                    onClick={() => setSelectedKeepId(row.id)}
                  >
                    <Check
                      className={`size-4 shrink-0 ${selected ? "opacity-100" : "opacity-0"}`}
                    />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="flex items-center gap-1 truncate">
                        {config.rowLabel(row)}
                      </span>
                      {config.rowStat && (
                        <span
                          className={`flex flex-wrap gap-x-2 text-xs ${
                            selected
                              ? "text-primary-foreground/80"
                              : "text-muted-foreground"
                          }`}
                        >
                          {config.rowStat(row)}
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
        </Stack>
        <MergeImpactPreview
          losers={rows
            .filter((row) => aliasIds.includes(row.id))
            .map((row) => ({ id: row.id, label: config.rowLabel(row) }))}
          operations={impactPreviewOperations}
        />
        <MergeDialogFooter
          disabled={isPending || !effectiveKeepId || aliasIds.length === 0}
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

/** "fixed" keeperMode: the record being viewed is always the survivor. */
function FixedMergeDialog<T extends MergeRow>({
  config,
  keeper,
  initialAliasIds,
  open,
  onOpenChange,
  onConfirm,
  isPending,
  impactPreviewOperations,
}: {
  config: MergeableConfig;
  keeper: T;
  initialAliasIds?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (keepId: string, aliasIds: string[]) => void;
  isPending: boolean;
  impactPreviewOperations?: ImpactPreviewOperations;
}) {
  const [selected, setSelected] = useState<string[]>(initialAliasIds ?? []);
  const candidatePlan = config.candidateQuery?.(keeper);
  const candidatesQuery = useQuery({
    queryKey: candidatePlan?.queryKey ?? ["merge-candidates", keeper.id],
    meta: candidatePlan?.meta,
    queryFn: async (context) => {
      if (!candidatePlan) {
        throw new Error("Merge configuration has no candidate plan");
      }
      return candidatePlan.execute(context.signal);
    },
    enabled: open && candidatePlan !== undefined,
  });
  const candidates = useMemo(
    () =>
      (candidatesQuery.data?.items ?? []).filter((row) => row.id !== keeper.id),
    [candidatesQuery.data, keeper.id],
  );
  const toggle = (id: string) =>
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
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
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
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
        <MergeImpactPreview
          losers={candidates
            .filter((candidate) => selected.includes(candidate.id))
            .map((candidate) => ({
              id: candidate.id,
              label: config.rowLabel(candidate),
            }))}
          operations={impactPreviewOperations}
        />
        <MergeDialogFooter
          disabled={selected.length === 0 || isPending}
          isPending={isPending}
          label={`Merge ${selected.length || ""}`.trim()}
          onCancel={() => onOpenChange(false)}
          onConfirm={() => onConfirm(keeper.id, selected)}
        />
      </DialogContent>
    </Dialog>
  );
}

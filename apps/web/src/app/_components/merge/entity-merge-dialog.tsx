import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { productMergePreview } from "@cubby/schemas/recommendations";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { skipToken, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import type { z } from "zod";

import {
  type ImpactPreviewOperations,
  MergeImpactPreview,
} from "~/app/_components/actions/entity-operation-impact-preview";
import { product } from "~/app/products/product.functions";
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
import type { MergeDisplayRow, MergeableConfig } from "~/entities/types";

/** Display text comes from `mergeable.rowLabel`/`rowStat`, not a hardcoded
 * `name` field — a row shape like `PurchaseOut` (no `name`) works here too. */
type MergeRow = MergeDisplayRow;

const MERGE_ACTION = {
  keep: { label: "Keep left", variant: "secondary" },
  fill: { label: "Fill from right", variant: "positive" },
  combine: { label: "Merge both", variant: "positive" },
  dedupe: { label: "Merge unique", variant: "positive" },
} as const;

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
      entity={entity}
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

function ProductMergeDecisions({
  data,
  error,
  isPending,
}: {
  data?: z.output<typeof productMergePreview>;
  error: Error | null;
  isPending: boolean;
}) {
  const visibleDecisions =
    data?.decisions.filter(
      (decision) =>
        decision.keeper !== "—" ||
        decision.incoming !== "—" ||
        decision.result !== "—",
    ) ?? [];
  return (
    <section aria-label="Product merge decisions" className="min-w-0 space-y-2">
      <h3 className="text-sm font-semibold">
        What the merged product will keep
      </h3>
      {isPending ? (
        <Description size="xs">Calculating field decisions…</Description>
      ) : error ? (
        <Description size="xs">{String(error)}</Description>
      ) : (
        <>
          {data?.blockers.map((blocker) => (
            <p
              key={blocker}
              className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
            >
              {blocker}
            </p>
          ))}
          <div
            data-testid="product-merge-mobile-decisions"
            className="divide-y divide-border rounded-md border border-border md:hidden"
          >
            {visibleDecisions.map((decision) => (
              <div key={decision.field} className="space-y-1.5 p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{decision.field}</span>
                  <Badge variant={MERGE_ACTION[decision.action].variant}>
                    {MERGE_ACTION[decision.action].label}
                  </Badge>
                </div>
                <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 break-words">
                  <span className="text-muted-foreground">Keep</span>
                  <span>{decision.keeper}</span>
                  <span className="text-muted-foreground">Merge in</span>
                  <span>{decision.incoming}</span>
                  <span className="font-medium">Result</span>
                  <span className="font-medium">{decision.result}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-md border border-border md:block">
            <table className="w-full min-w-[42rem] table-fixed border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 z-10 w-24 bg-card p-2"
                  >
                    Field
                  </th>
                  <th scope="col" className="p-2">
                    Keep product
                  </th>
                  <th scope="col" className="p-2">
                    Merge in
                  </th>
                  <th scope="col" className="w-30 p-2">
                    Action
                  </th>
                  <th scope="col" className="p-2">
                    Result
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleDecisions.map((decision) => (
                  <tr
                    key={decision.field}
                    className="border-t border-border align-top"
                  >
                    <th
                      scope="row"
                      className="sticky left-0 bg-card p-2 font-medium"
                    >
                      {decision.field}
                    </th>
                    <td className="p-2 break-words">{decision.keeper}</td>
                    <td className="p-2 break-words">{decision.incoming}</td>
                    <td className="p-2">
                      <Badge variant={MERGE_ACTION[decision.action].variant}>
                        {MERGE_ACTION[decision.action].label}
                      </Badge>
                    </td>
                    <td className="p-2 font-medium break-words">
                      {decision.result}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-2xs text-muted-foreground">
            Only fields with a value are shown. Kept values win; empty fields
            are filled. Names become searchable aliases; images and tags are
            combined, with exact duplicates removed.
          </p>
        </>
      )}
    </section>
  );
}

// The operation parses its input when the options are built, so an idle
// dialog (no keeper or no single alias yet) must not build them at all.
const useProductMergePreview = (
  active: boolean,
  keepId: string | null,
  aliasIds: readonly string[],
) => {
  const mergeId = aliasIds.length === 1 ? aliasIds[0] : undefined;
  const enabled = active && !!keepId && !!mergeId;
  // SAFETY: skipToken never runs the idle query, so it needs no operation
  // input; `never` keeps the enabled branch's typed data.
  const query = useQuery(
    enabled && keepId && mergeId
      ? product.mergePreview.queryOptions({ keepId, mergeId })
      : ({
          queryKey: ["product.mergePreview", "idle"],
          queryFn: skipToken,
        } as never),
  );
  return { enabled, query };
};

function RankedMergeDialog<T extends MergeRow>({
  entity,
  config,
  rows,
  open,
  onOpenChange,
  onConfirm,
  isPending,
  impactPreviewOperations,
}: {
  entity: BrowserRoutedEntity;
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
  const { enabled: productPreviewEnabled, query: productPreview } =
    useProductMergePreview(
      entity === "product" && open,
      effectiveKeepId,
      aliasIds,
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={productPreviewEnabled ? "sm:max-w-5xl" : undefined}
      >
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
                    <CheckIcon
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
        {productPreviewEnabled && (
          <ProductMergeDecisions
            data={productPreview.data}
            error={productPreview.error}
            isPending={productPreview.isPending}
          />
        )}
        <MergeImpactPreview
          losers={rows
            .filter((row) => aliasIds.includes(row.id))
            .map((row) => ({ id: row.id, label: config.rowLabel(row) }))}
          operations={impactPreviewOperations}
        />
        <MergeDialogFooter
          disabled={
            isPending ||
            !effectiveKeepId ||
            aliasIds.length === 0 ||
            (productPreviewEnabled &&
              (productPreview.isPending ||
                productPreview.isError ||
                !!productPreview.data?.blockers.length))
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

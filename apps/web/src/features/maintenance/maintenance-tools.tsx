import { CULL_PENDING_IMAGES_DEFAULT_HOURS } from "@cubby/schemas/image";
import type {
  ClassifyImageProvenanceOut,
  SearchIndexRepairCounters,
} from "@cubby/schemas/maintenance";
import type { MaintenanceCounts } from "@cubby/schemas/problems";
import { getErrorMessage } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import {
  openRecipeRecomputeAllStream,
  openRecipeRecomputeStaleStream,
} from "~/features/recipe/recipe-streams";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { imageUpload } from "~/integrations/tanstack-query/generated/domains/imageUpload.gen";
import { maintenance } from "~/integrations/tanstack-query/generated/domains/maintenance.gen";
import { problems } from "~/integrations/tanstack-query/generated/domains/problems.gen";
import { recipe } from "~/integrations/tanstack-query/generated/domains/recipe.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Eyebrow } from "~/ui/primitives/eyebrow";
import { StaticTable } from "~/ui/primitives/static-table";
import { tryFormatAmount } from "~/ui/text/format-amount";

import { BackfillButton } from "./backfill-button";
import { BACKFILL } from "./backfill-registry";
import {
  openProblemsPruneAliasesStream,
  openProblemsReparseStream,
} from "./maintenance-streams";
import { PendingButton } from "./pending-button";
import { openSearchIndexRepairStream } from "./search-streams";

/** Comparisons span the row below its description, never the narrow action slot. */
function MaintenanceRow({
  label,
  description,
  showCount = false,
  count,
  approximate = false,
  action,
  actionPlacement = "inline",
}: {
  label: string;
  description: string;
  showCount?: boolean;
  count?: number;
  /** External lookups attempt a candidate set rather than guaranteeing every change. */
  approximate?: boolean;
  action: ReactNode;
  actionPlacement?: "inline" | "below";
}) {
  const controls = (
    <Row align="center" gap="sm" className="max-w-full min-w-0 max-md:w-full">
      {showCount ? (
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {count == null
            ? "—"
            : approximate
              ? `up to ${count}`
              : `${count} to do`}
        </span>
      ) : null}
      {action}
    </Row>
  );
  return (
    <fieldset className="grid min-w-0 gap-2 py-3" aria-label={label}>
      <Row align="start" justify="between" gap="md" className="max-md:flex-col">
        <Stack gap="tight">
          <span className="text-sm font-medium">{label}</span>
          <Description size="xs" className="max-w-prose">
            {description}
          </Description>
        </Stack>
        {actionPlacement === "inline" ? controls : null}
      </Row>
      {actionPlacement === "below" ? (
        <div className="min-w-0">{action}</div>
      ) : null}
    </fieldset>
  );
}

// Shared layout for a Maintenance action whose "N affected" figure is too
// expensive for an always-on count, so it's fetched on demand: an optional
// summary, a "Dry run" button that triggers it, and the streaming "fix all"
// button. Each action component owns its own typed dry-run query and backfill,
// then feeds the resolved pieces into the shared row.
function MaintenanceDryRunRow({
  summary,
  onDryRun,
  dryRunPending,
  dryRunLabel = "Preview",
  backfill,
}: {
  summary: ReactNode;
  onDryRun: () => void;
  dryRunPending: boolean;
  dryRunLabel?: string;
  backfill: ReactNode;
}) {
  return (
    <Row align="center" gap="sm">
      {summary && (
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {summary}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onDryRun}
        disabled={dryRunPending}
      >
        {dryRunPending ? "Checking…" : dryRunLabel}
      </Button>
      {backfill}
    </Row>
  );
}

// Recompute's accurate "would change" needs a full compute+diff (~as costly as
// recomputing), so it's an on-demand preview rather than an always-on count.
// The force-recompute button stays — it's the only path that catches
// logic-change drift the stale flag misses. It publishes bounded queue tasks
// rather than holding one request open for the full CPU-heavy pass.
function RecomputeAction() {
  const dryRun = useQuery({
    ...recipe.dryRunRecomputeTotals.queryOptions(),
    enabled: false,
  });
  // Cheap always-on count of recipes whose totals are stale — shares the
  // card's cached query, so no extra round-trip. The Awaiting-work card is
  // where a lingering count gets settled.
  const { data: counts } = useQuery({
    ...problems.getMaintenanceCounts.queryOptions(),
  });
  return (
    <MaintenanceDryRunRow
      summary={
        dryRun.data
          ? `${dryRun.data.wouldChange} of ${dryRun.data.total} would change`
          : counts && counts.staleRecipeTotals > 0
            ? `${countLabel(counts.staleRecipeTotals, "recipe")} pending recompute`
            : null
      }
      onDryRun={() => void dryRun.refetch()}
      dryRunPending={dryRun.isFetching}
      backfill={
        <BackfillButton<{ enqueued: number; total: number }>
          run={(signal) => openRecipeRecomputeAllStream(signal)}
          invalidateTags={ripple.recipe}
          idleLabel="Run"
          pendingLabel="Publishing…"
          toastResult={(r) => ({
            tone: r.enqueued > 0 ? "success" : "info",
            message:
              r.enqueued > 0
                ? `Published ${countLabel(r.enqueued, "recipe")} for recompute; they run in the background.`
                : "Nothing to recompute.",
          })}
        />
      }
    />
  );
}

function RecomputeStaleAction() {
  return (
    <BackfillButton<{ enqueued: number; total: number }>
      run={(signal) => openRecipeRecomputeStaleStream(signal)}
      invalidateTags={ripple.recipeList}
      idleLabel="Run"
      pendingLabel="Publishing…"
      toastResult={(r) => ({
        tone: r.enqueued > 0 ? "success" : "info",
        message:
          r.enqueued > 0
            ? `Queued ${countLabel(r.enqueued, "recipe")} for recompute.`
            : "No stale recipe totals.",
      })}
    />
  );
}

function CullPendingImagesAction() {
  const cull = useActionMutation({
    mutationFn: imageUpload.cullPendingImages.mutationOptions,
    success: (r) =>
      r.count
        ? `Culled ${countLabel(r.count, "pending image")}`
        : "No abandoned uploads.",
  });
  return (
    <PendingButton
      onClick={() =>
        cull.mutate({ olderThanHours: CULL_PENDING_IMAGES_DEFAULT_HOURS })
      }
      isPending={cull.isPending}
      idleLabel="Run"
      pendingLabel="Culling…"
    />
  );
}

// Re-parse imported recipe lines with the current parser (the WASM sweep that
// used to run on every Problems-page load). Dry run counts the drifted lines;
// "Re-parse all" applies + recomputes affected totals.
function ReparseAction() {
  const [previewed, setPreviewed] = useState(false);
  const dryRun = useQuery({
    ...problems.dryRunReparse.queryOptions(),
    enabled: false,
  });
  return (
    <Stack gap="sm">
      <MaintenanceDryRunRow
        summary={
          dryRun.data
            ? `${dryRun.data.wouldChange} of ${dryRun.data.total} would change`
            : null
        }
        onDryRun={() => {
          setPreviewed(false);
          void dryRun
            .refetch()
            .then((result) => setPreviewed(result.isSuccess));
        }}
        dryRunPending={dryRun.isFetching}
        backfill={
          <BackfillButton<{ updated: number; recipesAffected: number }>
            disabled={
              !previewed || dryRun.isFetching || !dryRun.data?.wouldChange
            }
            run={(signal) => {
              setPreviewed(false);
              return openProblemsReparseStream(signal);
            }}
            invalidateTags={ripple.recipe}
            foreground
            idleLabel="Apply reparse repair"
            pendingLabel="Re-parsing…"
            toastResult={(r) => ({
              tone: r.updated > 0 ? "success" : "info",
              message:
                r.updated > 0
                  ? `Re-parsed ${countLabel(r.updated, "line")} across ${countLabel(r.recipesAffected, "recipe")}.`
                  : "Nothing to re-parse.",
            })}
          />
        }
      />
      {dryRun.error ? (
        <ErrorDisplay
          title="Recipe reparse preview"
          error={dryRun.error}
          onRetry={() => {
            setPreviewed(false);
            void dryRun
              .refetch()
              .then((result) => setPreviewed(result.isSuccess));
          }}
        />
      ) : null}
      {previewed && dryRun.data ? (
        <Stack gap="sm">
          <p className="max-w-prose text-xs text-muted-foreground">
            Showing {dryRun.data.sample.length} of {dryRun.data.wouldChange}{" "}
            changed lines. This repair can overwrite manual amounts, modifiers
            and ingredient choices. The server checks current eligibility again
            when applying; this preview does not lock the records.
          </p>
          <StaticTable
            rows={dryRun.data.sample}
            rowKey={(line) => line.recipeSectionIngredientId}
            columns={[
              {
                id: "recipe",
                header: "Recipe / original line",
                cell: (line) => (
                  <Stack gap="tight">
                    <EntityRefLink entity="recipe" id={line.recipeId} />
                    <span>{line.rawLine}</span>
                  </Stack>
                ),
              },
              {
                id: "current",
                header: "Current",
                cell: (line) => (
                  <span>
                    {line.storedName} ·{" "}
                    {line.storedAmounts
                      .map((amount) =>
                        tryFormatAmount({
                          ...amount,
                          upper_value: amount.upperValue,
                        }),
                      )
                      .join(", ")}
                    {line.storedModifier ? ` · ${line.storedModifier}` : ""}
                  </span>
                ),
              },
              {
                id: "proposed",
                header: "Proposed",
                cell: (line) => (
                  <span>
                    {line.parsedName} ·{" "}
                    {line.parsedAmounts
                      .map((amount) =>
                        tryFormatAmount({
                          ...amount,
                          upper_value: amount.upperValue,
                        }),
                      )
                      .join(", ")}
                    {line.parsedModifier ? ` · ${line.parsedModifier}` : ""}
                  </span>
                ),
              },
            ]}
          />
        </Stack>
      ) : null}
    </Stack>
  );
}

// Strip aliases that no recipe line matches (or that duplicate the name) from
// every ingredient at once — the other WASM sweep, also re-homed here. Dry run
// counts what would be pruned; "Prune all" applies it.
function PruneAliasesAction() {
  const [previewed, setPreviewed] = useState(false);
  const dryRun = useQuery({
    ...problems.dryRunPruneAliases.queryOptions(),
    enabled: false,
  });
  return (
    <Stack gap="sm">
      <MaintenanceDryRunRow
        summary={
          dryRun.data
            ? `${countLabel(dryRun.data.wouldPrune, "alias")} across ${countLabel(dryRun.data.ingredients, "ingredient")}`
            : null
        }
        onDryRun={() => {
          setPreviewed(false);
          void dryRun
            .refetch()
            .then((result) => setPreviewed(result.isSuccess));
        }}
        dryRunPending={dryRun.isFetching}
        backfill={
          <BackfillButton<{ pruned: number }>
            disabled={
              !previewed || dryRun.isFetching || !dryRun.data?.wouldPrune
            }
            run={(signal) => {
              setPreviewed(false);
              return openProblemsPruneAliasesStream(signal);
            }}
            invalidateTags={ripple.ingredient}
            foreground
            idleLabel="Apply alias pruning"
            pendingLabel="Pruning…"
            toastResult={(r) => ({
              tone: r.pruned > 0 ? "success" : "info",
              message:
                r.pruned > 0
                  ? `Pruned ${countLabel(r.pruned, "alias")}.`
                  : "No unused aliases to prune.",
            })}
          />
        }
      />
      {dryRun.error ? (
        <ErrorDisplay title="Alias pruning preview" error={dryRun.error} />
      ) : null}
      {previewed && dryRun.data ? (
        <Stack gap="sm">
          <p className="max-w-prose text-xs text-muted-foreground">
            Showing {dryRun.data.sample.length} of {dryRun.data.ingredients}{" "}
            affected Ingredients. Only the listed unused aliases are removed;
            the Ingredients remain. Eligibility is checked again when applying.
          </p>
          <StaticTable
            rows={dryRun.data.sample}
            rowKey={(item) => item.id}
            columns={[
              {
                id: "ingredient",
                header: "Ingredient",
                cell: (item) => (
                  <EntityRefLink entity="ingredient" id={item.id} />
                ),
              },
              {
                id: "current",
                header: "Current aliases",
                cell: (item) => item.aliases.join(", "),
              },
              {
                id: "remove",
                header: "Remove",
                cell: (item) => item.unusedAliases.join(", "),
              },
            ]}
          />
        </Stack>
      ) : null}
    </Stack>
  );
}

// One cancellable stream: retire orphaned documents, rebuild missing and
// stale projections, publish embedding refreshes. The toast reports THIS run's
// findings and outcomes; the Awaiting-work card is the live truth afterwards.
function RepairIndexAction() {
  return (
    <BackfillButton<SearchIndexRepairCounters>
      run={(signal) => openSearchIndexRepairStream(signal)}
      invalidateTags={ripple.search}
      idleLabel="Run"
      pendingLabel="Repairing…"
      toastResult={(r) => {
        const findings = r.orphaned + r.missing + r.stale;
        return {
          tone: findings > 0 ? "success" : "info",
          message:
            findings > 0
              ? `Scanned ${r.scanned}: retired ${r.retired} orphaned, rebuilt ${r.rebuilt} (${r.missing} missing, ${r.stale} stale), published ${countLabel(r.published, "embedding refresh")}.`
              : `Scanned ${r.scanned}: nothing to repair.`,
        };
      }}
    />
  );
}

// Decision classification for weak image-source evidence; Preview runs the
// same frozen candidate roster without publishing results.
export function ImageProvenanceAction({
  operations = {
    classifyImageProvenance:
      maintenance.classifyImageProvenance.mutationOptions,
  },
}: {
  operations?: {
    classifyImageProvenance: typeof maintenance.classifyImageProvenance.mutationOptions;
  };
}) {
  const [previewCursor, setPreviewCursor] = useState<string | undefined>();
  const [applyCursor, setApplyCursor] = useState<string | undefined>();
  const classify = useMutation(operations.classifyImageProvenance());
  const result = classify.data;
  return (
    <MaintenanceDryRunRow
      summary={
        <>
          {result && <ProvenanceSummary result={result} />}
          {classify.error && (
            <span
              role="alert"
              className="block whitespace-normal text-destructive"
            >
              {getErrorMessage(classify.error)}
            </span>
          )}
        </>
      }
      onDryRun={() =>
        classify.mutate(
          {
            dryRun: true,
            batchSize: 25,
            maxBatches: 1,
            afterId: previewCursor,
          },
          {
            onSuccess: (page) => setPreviewCursor(page.nextCursor ?? undefined),
          },
        )
      }
      dryRunPending={classify.isPending}
      backfill={
        <Button
          size="sm"
          disabled={classify.isPending}
          onClick={() =>
            classify.mutate(
              {
                dryRun: false,
                batchSize: 25,
                maxBatches: 20,
                afterId: applyCursor,
              },
              {
                onSuccess: (page) =>
                  setApplyCursor(page.nextCursor ?? undefined),
              },
            )
          }
        >
          {applyCursor ? "Continue" : "Apply"}
        </Button>
      }
    />
  );
}

const BATCH_STOPPED_LABEL = {
  complete: "no more candidates",
  limit: "batch limit reached — more may remain",
  no_progress: "the last batch made no progress",
} satisfies Record<ClassifyImageProvenanceOut["stopped"], string>;

function ProvenanceSummary({ result }: { result: ClassifyImageProvenanceOut }) {
  const detail = [
    BATCH_STOPPED_LABEL[result.stopped],
    result.capturedAtSeeded > 0 &&
      `seeded capture date on ${countLabel(result.capturedAtSeeded, "image")}`,
    result.unresolved > 0 && `${result.unresolved} remain unresolved`,
  ].filter(Boolean);
  return (
    <span title={detail.join(" · ")}>
      {result.dryRun ? "would classify" : "classified"} {result.classified} of{" "}
      {result.scanned} · {result.remaining} unknown
    </span>
  );
}

// One-off tools, grouped by what they rebuild. Declared as data (each row's
// typed action lives in `action`); the card maps groups then rows. Rows share
// one grammar — plain description, an always-on count only where it is cheap,
// one primary action, a Preview only where a dry run exists.
type MaintenanceTool = {
  label: string;
  description: string;
  // Always-on affected count; omitted for tools whose accurate count is
  // expensive (recompute uses an on-demand preview instead).
  count?: (c: MaintenanceCounts) => number;
  // Count is a candidate set the action only attempts (external lookup/API may
  // not change every one) → shown as "up to N" rather than "N affected".
  approximate?: boolean;
  action: ReactNode;
  actionPlacement?: "inline" | "below";
};

const MAINTENANCE_GROUPS: { group: string; tools: MaintenanceTool[] }[] = [
  {
    group: "Search",
    tools: [
      {
        label: "Repair index",
        description:
          "Compare the search index with every live record: retire documents whose record is gone, rebuild missing or stale ones, and refresh their embeddings in the background. The repair continues if you leave this page.",
        action: <RepairIndexAction />,
      },
    ],
  },
  {
    group: "Recipes",
    tools: [
      {
        label: "Recompute stale totals",
        description:
          "Rebuild the cost, calorie, and macro rollup of recipes marked stale.",
        count: (c) => c.staleRecipeTotals,
        action: <RecomputeStaleAction />,
      },
      {
        label: "Recompute all totals",
        description:
          "Rebuild every recipe's cost, calorie, and macro rollup — even ones not marked stale — for when the costing logic itself changed.",
        action: <RecomputeAction />,
      },
      {
        label: "Re-parse lines",
        description:
          "Re-run the ingredient parser over each recipe line as it was originally written. Overwrites manual edits to those lines, so preview first.",
        action: <ReparseAction />,
        actionPlacement: "below",
      },
      {
        label: "Prune unused aliases",
        description:
          "Remove ingredient aliases that no recipe line matches or that duplicate the ingredient's name. The ingredients themselves stay.",
        action: <PruneAliasesAction />,
        actionPlacement: "below",
      },
    ],
  },
  {
    group: "Images",
    tools: [
      {
        label: "Cull abandoned uploads",
        description: `Remove pending images whose upload never finished after ${CULL_PENDING_IMAGES_DEFAULT_HOURS} hours.`,
        count: (c) => c.cullablePendingImages,
        action: <CullPendingImagesAction />,
      },
      {
        label: "Classify provenance",
        description:
          "Review still-unknown image sources using bounded evidence and seed a missing capture date from on-device photo analysis. Preview first — Apply writes only high-confidence classifications.",
        action: <ImageProvenanceAction />,
      },
    ],
  },
  {
    group: "Products",
    tools: [
      {
        label: "Fetch UPC images",
        description:
          "Pull product images from the UPC database for products missing one.",
        count: (c) => c.productsWithNoImages,
        // A UPC lookup can return no image, so not every candidate gets one.
        approximate: true,
        action: <BackfillButton {...BACKFILL.fetchUpcImages} />,
      },
    ],
  },
];

/**
 * One-off repair tools in Activity → Advanced maintenance. Routine upkeep runs
 * automatically; Activity supplies the heading.
 */
export function MaintenanceTools() {
  // Always-on "N to do" figures — one cheap DB query (no USDA/UPC network).
  const { data: counts } = useQuery({
    ...problems.getMaintenanceCounts.queryOptions(),
  });

  return (
    <Stack gap="lg">
      {MAINTENANCE_GROUPS.map(({ group, tools }) => (
        <Stack key={group} gap="tight">
          <Eyebrow>{group}</Eyebrow>
          <div className="divide-y divide-border/60">
            {tools.map((t) => (
              <MaintenanceRow
                key={t.label}
                label={t.label}
                description={t.description}
                showCount={!!t.count}
                count={t.count && counts ? t.count(counts) : undefined}
                approximate={t.approximate}
                action={t.action}
                actionPlacement={t.actionPlacement}
              />
            ))}
          </div>
        </Stack>
      ))}
    </Stack>
  );
}

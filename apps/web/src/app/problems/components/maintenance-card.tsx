import type { SearchIndexRepairCounters } from "@cubby/schemas/maintenance";
import type { MaintenanceCounts } from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  openRecipeRecomputeAllStream,
  recipe,
} from "~/app/recipes/recipe.functions";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Eyebrow } from "~/components/ui/eyebrow";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { countLabel } from "~/lib/pluralize";
import {
  openProblemsPruneAliasesStream,
  openProblemsReparseStream,
  problems,
} from "~/lib/problems.functions";
import { openSearchIndexRepairStream } from "~/lib/search.functions";

import { BACKFILL } from "./backfill-registry";
import { ImageMetadataMaintenance } from "./image-metadata-maintenance";
import { ImageProcessingMaintenance } from "./image-processing-maintenance";
import { ImageProvenanceMaintenance } from "./image-provenance-maintenance";
import { BackfillButton } from "./problem-backfill-action";

/** One labeled maintenance action: description left, dry-run count + run-button right. */
function MaintenanceRow({
  label,
  description,
  showCount = false,
  count,
  approximate = false,
  action,
}: {
  label: string;
  description: string;
  /** Whether this tool has an always-on affected count. */
  showCount?: boolean;
  /** The affected figure; undefined while the counts query loads. */
  count?: number;
  /**
   * Count is a candidate set the action only *attempts* (an external lookup/API
   * may not change every one) → render "up to N" instead of "N affected".
   */
  approximate?: boolean;
  action: ReactNode;
}) {
  return (
    <Row align="start" justify="between" gap="md" className="py-4">
      <Stack gap="tight">
        <span className="text-sm font-medium">{label}</span>
        <Description size="xs">{description}</Description>
      </Stack>
      <Row align="center" gap="sm" className="shrink-0">
        {showCount && (
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {count == null
              ? "—"
              : approximate
                ? `up to ${count}`
                : `${count} to do`}
          </span>
        )}
        {action}
      </Row>
    </Row>
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

// Re-parse imported recipe lines with the current parser (the WASM sweep that
// used to run on every Problems-page load). Dry run counts the drifted lines;
// "Re-parse all" applies + recomputes affected totals.
function ReparseAction() {
  const dryRun = useQuery({
    ...problems.dryRunReparse.queryOptions(),
    enabled: false,
  });
  return (
    <MaintenanceDryRunRow
      summary={
        dryRun.data
          ? `${dryRun.data.wouldChange} of ${dryRun.data.total} would change`
          : null
      }
      onDryRun={() => void dryRun.refetch()}
      dryRunPending={dryRun.isFetching}
      backfill={
        <BackfillButton<{ updated: number; recipesAffected: number }>
          run={openProblemsReparseStream}
          invalidateTags={ripple.recipe}
          foreground
          idleLabel="Run"
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
  );
}

// Strip aliases that no recipe line matches (or that duplicate the name) from
// every ingredient at once — the other WASM sweep, also re-homed here. Dry run
// counts what would be pruned; "Prune all" applies it.
function PruneAliasesAction() {
  const dryRun = useQuery({
    ...problems.dryRunPruneAliases.queryOptions(),
    enabled: false,
  });
  return (
    <MaintenanceDryRunRow
      summary={
        dryRun.data
          ? `${countLabel(dryRun.data.wouldPrune, "alias")} across ${countLabel(dryRun.data.ingredients, "ingredient")}`
          : null
      }
      onDryRun={() => void dryRun.refetch()}
      dryRunPending={dryRun.isFetching}
      backfill={
        <BackfillButton<{ pruned: number }>
          run={openProblemsPruneAliasesStream}
          invalidateTags={ripple.ingredient}
          foreground
          idleLabel="Run"
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
      },
      {
        label: "Prune unused aliases",
        description:
          "Remove ingredient aliases that no recipe line matches or that duplicate the ingredient's name. The ingredients themselves stay.",
        action: <PruneAliasesAction />,
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
 * The shared "Maintenance" card: one-off tools that rebuild derived data on
 * demand. Routine upkeep no longer lives here — search projections are written
 * with the entity, valuations are computed on read, and anything waiting on a
 * queue wakeup shows in the Awaiting-work card. Rendered on BOTH the Problems
 * page (so a "fix this" affordance lives next to the issues) and Settings →
 * Developer / Maintenance (so the tools are reachable even when the page is
 * clean).
 */
export function MaintenanceCard() {
  // Always-on "N to do" figures — one cheap DB query (no USDA/UPC network).
  const { data: counts } = useQuery({
    ...problems.getMaintenanceCounts.queryOptions(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <CardDescription>
          Rebuilds derived data on demand. Routine upkeep happens at write time;
          these are one-off tools.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Stack gap="lg">
          <ImageProcessingMaintenance />
          <ImageProvenanceMaintenance />
          <ImageMetadataMaintenance />
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
                  />
                ))}
              </div>
            </Stack>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}

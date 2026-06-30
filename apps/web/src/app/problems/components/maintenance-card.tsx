import type { MaintenanceCounts } from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import pluralize from "pluralize";
import type { ReactNode } from "react";
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
import { useTRPC } from "~/trpc/react";
import { BACKFILL } from "./backfill-registry";
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
        <span className="font-medium text-sm">{label}</span>
        <Description size="xs">{description}</Description>
      </Stack>
      <Row align="center" gap="sm" className="shrink-0">
        {showCount && (
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {count == null
              ? "—"
              : approximate
                ? `up to ${count}`
                : `${count} affected`}
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
// button. Each action component owns its own (typed) tRPC dry-run query + backfill
// and feeds the resolved pieces in — keeping trpc's inference natural per site.
function MaintenanceDryRunRow({
  summary,
  onDryRun,
  dryRunPending,
  backfill,
}: {
  summary: string | null;
  onDryRun: () => void;
  dryRunPending: boolean;
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
        {dryRunPending ? "Checking…" : "Dry run"}
      </Button>
      {backfill}
    </Row>
  );
}

// Recompute's accurate "would change" needs a full compute+diff (~as costly as
// recomputing), so it's an on-demand dry run rather than an always-on count. The
// force-recompute button stays — it's the only path that catches logic-change
// drift the stale flag misses.
function RecomputeAction() {
  const trpc = useTRPC();
  const dryRun = useQuery({
    ...trpc.recipe.dryRunRecomputeTotals.queryOptions(),
    enabled: false,
  });
  // Cheap always-on count of recipes whose totals are stale (pending recompute) —
  // shares the card's cached query, so no extra round-trip. The queue normally
  // clears these in seconds; a lingering count flags a stuck/lost wave.
  const { data: counts } = useQuery(
    trpc.problems.getMaintenanceCounts.queryOptions(undefined, {
      staleTime: 30_000,
    }),
  );
  return (
    <MaintenanceDryRunRow
      summary={
        dryRun.data
          ? `${dryRun.data.wouldChange} of ${dryRun.data.total} would change`
          : counts && counts.staleRecipeTotals > 0
            ? `${pluralize("recipe", counts.staleRecipeTotals, true)} pending recompute`
            : null
      }
      onDryRun={() => void dryRun.refetch()}
      dryRunPending={dryRun.isFetching}
      backfill={
        <BackfillButton<{ processed: number }>
          run={(client) => client.recipe.recomputeAllStream.mutate()}
          invalidateKeys={(api) => [api.recipe.list.queryKey()]}
          idleLabel="Recompute all"
          pendingLabel="Recomputing…"
          toastResult={(r) => ({
            tone: "success",
            message: `Recomputed ${pluralize("recipe", r.processed, true)}.`,
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
  const trpc = useTRPC();
  const dryRun = useQuery({
    ...trpc.problems.dryRunReparse.queryOptions(),
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
          run={(client) => client.problems.reparseStale.mutate()}
          invalidateKeys={(api) => [api.recipe.list.queryKey()]}
          idleLabel="Re-parse all"
          pendingLabel="Re-parsing…"
          toastResult={(r) => ({
            tone: r.updated > 0 ? "success" : "info",
            message:
              r.updated > 0
                ? `Re-parsed ${pluralize("line", r.updated, true)} across ${pluralize("recipe", r.recipesAffected, true)}.`
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
  const trpc = useTRPC();
  const dryRun = useQuery({
    ...trpc.problems.dryRunPruneAliases.queryOptions(),
    enabled: false,
  });
  return (
    <MaintenanceDryRunRow
      summary={
        dryRun.data
          ? `${pluralize("alias", dryRun.data.wouldPrune, true)} across ${pluralize("ingredient", dryRun.data.ingredients, true)}`
          : null
      }
      onDryRun={() => void dryRun.refetch()}
      dryRunPending={dryRun.isFetching}
      backfill={
        <BackfillButton<{ pruned: number }>
          run={(client) => client.problems.pruneAllUnusedAliasesStream.mutate()}
          invalidateKeys={(api) => [api.ingredient.list.queryKey()]}
          idleLabel="Prune all"
          pendingLabel="Pruning…"
          toastResult={(r) => ({
            tone: r.pruned > 0 ? "success" : "info",
            message:
              r.pruned > 0
                ? `Pruned ${pluralize("alias", r.pruned, true)}.`
                : "No unused aliases to prune.",
          })}
        />
      }
    />
  );
}

// Batch operations that also surface on the Problems page when something needs
// attention — here they run on demand regardless of state, via the same
// BackfillButton plumbing (toast + invalidate). Declared as data (each row's
// typed BackfillButton lives in `action`, mirroring the Problems registry's
// `headerAction`); the card just maps over them.
const MAINTENANCE_TOOLS: {
  label: string;
  description: string;
  // Always-on affected count; omitted for tools whose accurate count is
  // expensive (recompute uses an on-demand dry run instead).
  count?: (c: MaintenanceCounts) => number;
  // Count is a candidate set the action only attempts (external lookup/API may
  // not change every one) → shown as "up to N" rather than "N affected".
  approximate?: boolean;
  action: ReactNode;
}[] = [
  {
    label: "Recompute recipe totals",
    description:
      "Rebuild every recipe's cost / calorie / macro rollup, even when not marked stale.",
    action: <RecomputeAction />,
  },
  {
    label: "Re-parse recipe lines",
    description:
      "Re-run the ingredient parser over imported lines (rawLine). Reverts manual structured edits — intended. Dry run before applying.",
    action: <ReparseAction />,
  },
  {
    label: "Prune unused aliases",
    description:
      "Strip aliases that no recipe line matches (or that duplicate the ingredient's name) from every ingredient. The ingredients themselves stay.",
    action: <PruneAliasesAction />,
  },
  {
    label: "Fetch UPC images",
    description:
      "Pull product images from the UPC database for products missing one.",
    count: (c) => c.productsWithNoImages,
    // A UPC lookup can return no image, so not every candidate gets one.
    approximate: true,
    action: <BackfillButton {...BACKFILL.fetchUpcImages} />,
  },
  {
    label: "Analyze location descriptions",
    description:
      "Generate AI descriptions for locations that don't have one yet.",
    count: (c) => c.locationsWithoutAiDescription,
    // An AI generation can fail, so not every candidate ends up described.
    approximate: true,
    action: <BackfillButton {...BACKFILL.analyzeDescriptions} />,
  },
];

/**
 * The shared "Maintenance" card: force-run batch fixes (recompute totals,
 * re-parse lines, prune aliases, fetch UPC images, analyze descriptions) on
 * demand, independent of whether the Problems page currently flags them. Rendered
 * on BOTH the Problems page (so a "fix this" affordance lives next to the issues)
 * and Settings → Developer / Maintenance (so the tools are reachable even when
 * the page is clean).
 */
export function MaintenanceCard() {
  const trpc = useTRPC();
  // Dry-run "N affected" figures — one cheap DB/WASM query (no USDA/UPC network).
  const { data: counts } = useQuery(
    trpc.problems.getMaintenanceCounts.queryOptions(undefined, {
      staleTime: 30_000,
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <CardDescription>
          Force-run batch operations on demand — independent of whether the
          Problems page currently flags them.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        {MAINTENANCE_TOOLS.map((t) => (
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
      </CardContent>
    </Card>
  );
}

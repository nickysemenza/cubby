import { CULL_PENDING_IMAGES_DEFAULT_HOURS } from "@cubby/schemas/image";
import type { MaintenanceCounts } from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import pluralize from "pluralize";
import type { ReactNode } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
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
import { useTRPC } from "~/integrations/trpc/react";
import { problemsMutationInvalidateKeys, queryKeys } from "~/lib/query-keys";
import { PROBLEMS_QUERY_STALE_TIME } from "../problem-query-freshness";
import { searchDocumentMaintenanceRefetchInterval } from "../search-document-maintenance-query";
import { BACKFILL } from "./backfill-registry";
import { ProblemActionButton } from "./problem-action-button";
import { BackfillButton } from "./problem-backfill-action";

// Module-level so the arrays keep a stable identity across renders (the counts
// query + useActionMutation both key off them).
const CULL_INVALIDATE_KEYS = [
  queryKeys.image.list,
  ...problemsMutationInvalidateKeys,
] as const;
const VALUATION_INVALIDATE_KEYS = [
  queryKeys.location.all,
  ...problemsMutationInvalidateKeys,
] as const;

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
  dryRunLabel = "Dry run",
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
// recomputing), so it's an on-demand dry run rather than an always-on count. The
// force-recompute button stays — it's the only path that catches logic-change
// drift the stale flag misses. It's DURABLE: instead of holding one request open
// to do the full CPU-heavy pass inline (which dies on navigate-away / PWA
// background / Worker CPU limit), it enqueues bounded jobs onto the background-jobs
// queue and links the toast there (mirrors "Analyze descriptions").
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
      staleTime: PROBLEMS_QUERY_STALE_TIME,
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
        <BackfillButton<{
          enqueued: number;
          total: number;
          batchId: string | null;
        }>
          run={(client) => client.recipe.recomputeAllDurable.mutate()}
          invalidateKeys={(api) => [api.recipe.list.queryKey()]}
          idleLabel="Recompute all"
          pendingLabel="Enqueuing…"
          toastResult={(r) => ({
            tone: r.enqueued > 0 ? "success" : "info",
            message:
              r.enqueued > 0 ? (
                <span>
                  Enqueued {pluralize("recipe", r.enqueued, true)} for
                  recompute.{" "}
                  {r.batchId ? (
                    <Link
                      to="/background-jobs"
                      search={{ batchId: r.batchId }}
                      className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
                    >
                      View progress
                    </Link>
                  ) : null}
                </span>
              ) : (
                "Nothing to recompute."
              ),
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
          foreground
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
          foreground
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

// This reads the latest persisted repair batch only; it never starts a
// full-catalog diagnostic from the Problems page.
function SearchDocumentsAction() {
  const trpc = useTRPC();
  const health = useQuery({
    ...trpc.search.documentHealth.queryOptions(),
    staleTime: 30_000,
    refetchInterval: (query) =>
      searchDocumentMaintenanceRefetchInterval(query.state.data),
  });
  const repair = useActionMutation({
    mutationFn: trpc.search.repairDocuments.mutationOptions,
    invalidateKeys: [queryKeys.search.all],
    success: (result) => (
      <span>
        {result.reused ? "Repair already running. " : "Repair started. "}
        <Link
          to="/background-jobs"
          search={{ batchId: result.batch.id }}
          className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
        >
          View progress
        </Link>
      </span>
    ),
  });
  const summary: ReactNode = health.data ? (
    health.data.state === "never-run" ? (
      "Not audited yet"
    ) : health.data.state === "running" ? (
      <span>
        Auditing · {health.data.findings.total} findings so far
        {health.data.batchId ? (
          <>
            {" · "}
            <Link
              to="/background-jobs"
              search={{ batchId: health.data.batchId }}
              className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
            >
              View progress
            </Link>
          </>
        ) : null}
      </span>
    ) : health.data.findings.total === 0 ? (
      "Index healthy"
    ) : (
      `${health.data.findings.missing} missing · ${health.data.findings.orphaned} orphaned · ${health.data.findings.stale} stale`
    )
  ) : null;

  return (
    <MaintenanceDryRunRow
      summary={summary}
      onDryRun={() => void health.refetch()}
      dryRunPending={health.isFetching}
      dryRunLabel="Refresh"
      backfill={
        <ProblemActionButton
          onClick={() => repair.mutate(undefined)}
          isPending={repair.isPending}
          idleLabel="Repair index"
          pendingLabel="Enqueuing…"
        />
      }
    />
  );
}

// Delete abandoned uploads: PENDING image rows with no entity association that
// are older than the cull threshold, plus their R2 objects. Plain (non-streamed)
// mutation, so it uses useActionMutation rather than the BackfillButton stream.
function CullPendingImagesAction() {
  const api = useTRPC();
  const cull = useActionMutation({
    mutationFn: api.image.cullPendingImages.mutationOptions,
    success: (data) =>
      data.count > 0
        ? `Deleted ${pluralize("pending image", data.count, true)}.`
        : "No pending images to cull.",
    invalidateKeys: CULL_INVALIDATE_KEYS,
  });

  return (
    <ProblemActionButton
      onClick={() =>
        cull.mutate({ olderThanHours: CULL_PENDING_IMAGES_DEFAULT_HOURS })
      }
      isPending={cull.isPending}
      idleLabel="Cull now"
      pendingLabel="Culling…"
    />
  );
}

// Delete UPLOADED files no edge reaches, plus their R2 objects. The fix path for
// the "Unreferenced files" Problems section — mostly residue from entity deletes,
// whose cascade soft-deletes the join row and leaves the file behind.
function CleanupUnreferencedImagesAction() {
  const api = useTRPC();
  const cleanup = useActionMutation({
    mutationFn: api.image.cleanupUnreferencedImages.mutationOptions,
    success: (data) =>
      data.count > 0
        ? `Deleted ${pluralize("unreferenced file", data.count, true)}.`
        : "No unreferenced files.",
    invalidateKeys: CULL_INVALIDATE_KEYS,
  });

  return (
    <ProblemActionButton
      onClick={() => cleanup.mutate(undefined)}
      isPending={cleanup.isPending}
      idleLabel="Delete now"
      pendingLabel="Deleting…"
    />
  );
}

// Rebuild every location's persisted valuation rollup. Idempotent; the safety
// net for writes that bypass the router (raw SQL / postgres MCP).
function RecomputeValuationsAction() {
  const api = useTRPC();
  const recompute = useActionMutation({
    mutationFn: api.location.recomputeValuations.mutationOptions,
    success: (data) =>
      `Recomputed ${pluralize("location", data.updated, true)}.`,
    invalidateKeys: VALUATION_INVALIDATE_KEYS,
  });

  return (
    <ProblemActionButton
      onClick={() => recompute.mutate(undefined)}
      isPending={recompute.isPending}
      idleLabel="Recompute all"
      pendingLabel="Recomputing…"
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
      "Re-run the ingredient parser over each recipe line as it was originally written. Reverts manual structured edits — intended. Dry run before applying.",
    action: <ReparseAction />,
  },
  {
    label: "Prune unused aliases",
    description:
      "Strip aliases that no recipe line matches (or that duplicate the ingredient's name) from every ingredient. The ingredients themselves stay.",
    action: <PruneAliasesAction />,
  },
  {
    label: "Check search index",
    description:
      "Compare the indexed catalog with every live searchable record. Retire orphaned rows and durably rebuild missing or stale documents.",
    action: <SearchDocumentsAction />,
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
  {
    label: "Cull pending images",
    description: `Delete abandoned uploads — PENDING images with no entity, older than ${CULL_PENDING_IMAGES_DEFAULT_HOURS}h — from the database and R2.`,
    count: (c) => c.cullablePendingImages,
    action: <CullPendingImagesAction />,
  },
  {
    label: "Delete unreferenced files",
    description:
      "Delete UPLOADED files nothing points at — R2 pays for them and no page can render them — from the database and R2.",
    count: (c) => c.unreferencedImages,
    action: <CleanupUnreferencedImagesAction />,
  },
  {
    label: "Recompute location valuations",
    description:
      "Rebuild every location's stored inventory-value rollup (direct + descendants). Idempotent; catches writes that bypassed the app.",
    action: <RecomputeValuationsAction />,
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
      staleTime: PROBLEMS_QUERY_STALE_TIME,
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

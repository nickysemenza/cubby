import { CULL_PENDING_IMAGES_DEFAULT_HOURS } from "@cubby/schemas/image";
import type { AllProblems, MaintenanceCounts } from "@cubby/schemas/problems";
import type { QueryKey } from "@tanstack/react-query";
import pluralize from "pluralize";
import type { useTRPCClient } from "~/integrations/trpc/react";
import { collectBulkStream } from "~/lib/bulk-progress";
import { queryKeys } from "~/lib/query-keys";

type TRPCClient = ReturnType<typeof useTRPCClient>;

/** What one task did, for the run's summary toast. */
type AutoFixOutcome = {
  /** Clause for the summary toast; null when the task turned out to be a no-op. */
  summary: string | null;
  /** Set when the task enqueued durable work, so the toast can link to it. */
  batchId?: string | null;
};

export type AutoFixTask = {
  key: string;
  label: string;
  /**
   * How many items this task would act on right now. `null` means "not
   * countable" — such a task never contributes to the headline figure and only
   * runs alongside a task that does (see `alwaysRun`).
   */
  count: (
    problems: AllProblems,
    counts: MaintenanceCounts | undefined,
  ) => number | null;
  /**
   * How many of `count` are actually represented in `problems.totalProblems` —
   * the only figure the summary card may phrase as "N of them".
   *
   * REQUIRED, deliberately: a task's count and its listed count diverge more
   * often than not, and every task that draws its count from `MaintenanceCounts`
   * rather than an `AllProblems` array contributes ZERO here — that describes
   * three of the six. Defaulting this to `count` silently overcounted twice
   * during review, so each task must now state where its number comes from and
   * the compiler enforces it.
   */
  listedCount: (
    problems: AllProblems,
    counts: MaintenanceCounts | undefined,
  ) => number;
  /** Run alongside the others even at a zero/unknown count (idempotent tail steps). */
  alwaysRun?: boolean;
  run: (client: TRPCClient) => Promise<AutoFixOutcome>;
  /** Entity lists to invalidate once the whole run finishes. */
  invalidateKeys?: readonly QueryKey[];
};

/**
 * The fixes the top-of-page "Fix" button runs — every Problems remedy that
 * needs no human judgment.
 *
 * Membership rule, so this list doesn't quietly grow teeth: a task belongs here
 * only if it is idempotent, non-destructive, and either instant or durable on
 * the background-jobs queue. Deliberately absent, each for a stated reason:
 *
 *  - `product.backfillUPCImages` — does all its work inside one held-open
 *    request. Navigating away, backgrounding the PWA, or hitting the Worker CPU
 *    limit kills it with no record. It keeps its own section button, where the
 *    "keep this page open" warning is visible.
 *  - `problems.reparseStale` — reverts manual structured edits. Intended
 *    behavior, but that is a decision, not a no-op.
 *  - `problems.pruneAllUnusedAliasesStream` — safe, but a foreground WASM sweep
 *    with no upfront count, so the button couldn't say what it would do.
 *  - `problems.deleteUnused` / `product.applyUpcData` — destructive or
 *    overwrite stored data; they keep their confirm gates.
 *  - `recipe.recomputeAllDurable` — re-stales all 603 recipes regardless of
 *    need. The button uses the stale-only sibling instead.
 *
 * Each task runs in its OWN request (see auto-fix-button). Composing them into
 * one server procedure would rebuild exactly the monolith that blew the 30s
 * Worker CPU limit and forced the Problems page into cost-grouped queries.
 */
export const AUTO_FIX_TASKS: AutoFixTask[] = [
  {
    key: "orphanedEmbeddings",
    label: "Clean orphaned embeddings",
    count: (problems) => problems.orphanedEntityEmbeddings.length,
    // Its own section, uncapped — every item is on the page.
    listedCount: (problems) => problems.orphanedEntityEmbeddings.length,
    invalidateKeys: [queryKeys.search.all],
    // Omitting `ids` cleans every orphan — the server already supports it.
    run: async (client) => {
      const r = await client.problems.cleanupOrphanedEmbeddings.mutate({});
      return {
        summary: r.deleted
          ? `cleaned ${pluralize("orphaned embedding", r.deleted, true)}`
          : null,
      };
    },
  },
  {
    key: "cullPendingImages",
    label: "Cull abandoned uploads",
    count: (_problems, counts) => counts?.cullablePendingImages ?? null,
    // Abandoned uploads are maintenance, not a detected problem — there's no
    // Problems section for them, so none of this work is in `totalProblems`.
    listedCount: () => 0,
    invalidateKeys: [queryKeys.image.list],
    run: async (client) => {
      const r = await client.image.cullPendingImages.mutate({
        olderThanHours: CULL_PENDING_IMAGES_DEFAULT_HOURS,
      });
      return {
        summary: r.count
          ? `culled ${pluralize("pending image", r.count, true)}`
          : null,
      };
    },
  },
  {
    key: "locationDescriptions",
    label: "Analyze location photos",
    count: (problems) => problems.locationsWithoutAiDescription.length,
    // Its own section, uncapped.
    listedCount: (problems) => problems.locationsWithoutAiDescription.length,
    invalidateKeys: [queryKeys.location.list],
    run: async (client) => {
      const r = await collectBulkStream(
        await client.ai.backfillLocationDescriptions.mutate(),
      );
      return {
        summary: r.enqueued
          ? `queued ${pluralize("location", r.enqueued, true)} for analysis`
          : null,
        batchId: r.batchId,
      };
    },
  },
  {
    key: "missingEmbeddings",
    label: "Backfill search embeddings",
    // The Problems section only carries a sampled list, so the true figure comes
    // from the maintenance counts.
    count: (_problems, counts) => counts?.entitiesMissingEmbeddings ?? null,
    // The section is a capped sample, so only what's listed counts toward the
    // total — a model swap can make the true figure dwarf it.
    listedCount: (problems) => problems.entitiesMissingEmbeddings.length,
    invalidateKeys: [queryKeys.search.all],
    // Called unbounded on purpose: `limit` selects an arbitrary per-type window
    // rather than a needs-work one, so a bounded call can enqueue nothing useful
    // and never converge.
    run: async (client) => {
      const r = await client.search.enqueueEmbeddingBackfill.mutate({});
      return {
        summary: r.totalJobs
          ? `queued ${pluralize("embedding", r.totalJobs, true)}`
          : null,
        batchId: r.batchId,
      };
    },
  },
  {
    key: "staleRecipeTotals",
    label: "Recompute stale recipe totals",
    count: (_problems, counts) => counts?.staleRecipeTotals ?? null,
    // Maintenance-only, like the image cull: `staleRecipeTotals` lives in
    // MaintenanceCounts and has no Problems section, so none of it is in the
    // total. (`staleParentRecipes` is a different, unrelated detector.)
    listedCount: () => 0,
    invalidateKeys: [queryKeys.recipe.list],
    run: async (client) => {
      const r = await collectBulkStream(
        await client.recipe.recomputeStaleDurable.mutate(),
      );
      return {
        summary: r.enqueued
          ? `queued ${pluralize("recipe", r.enqueued, true)} for recompute`
          : null,
        batchId: r.batchId,
      };
    },
  },
  {
    key: "locationValuations",
    label: "Recompute location valuations",
    // No detector backs this — it's the idempotent safety net for writes that
    // bypassed the router (raw SQL / postgres MCP), so there is nothing to
    // count. Rides along whenever the button runs; never justifies a run alone.
    count: () => null,
    listedCount: () => 0,
    alwaysRun: true,
    invalidateKeys: [queryKeys.location.all],
    run: async (client) => {
      const r = await client.location.recomputeValuations.mutate();
      return {
        summary: r.updated
          ? `revalued ${pluralize("location", r.updated, true)}`
          : null,
      };
    },
  },
];

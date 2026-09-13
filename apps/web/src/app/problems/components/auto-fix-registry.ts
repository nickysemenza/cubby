import { CULL_PENDING_IMAGES_DEFAULT_HOURS } from "@cubby/schemas/image";
import type { AllProblems, MaintenanceCounts } from "@cubby/schemas/problems";
import { sumBy } from "es-toolkit";
import pluralize from "pluralize";

import { openRecipeRecomputeStaleStream } from "~/app/recipes/recipe.functions";
import {
  ripple,
  type InvalidationTagSet,
} from "~/integrations/tanstack-query/cache-tags";
import { backfillLocationDescriptionsStream } from "~/lib/ai.functions";
import { collectBulkStream } from "~/lib/bulk-progress";
import { imageUpload } from "~/lib/image.functions";
import { maintenance } from "~/lib/maintenance.functions";

/** What one task did, for the run's summary toast. */
type AutoFixOutcome = {
  /** Clause for the summary toast; null when the task turned out to be a no-op. */
  summary: string | null;
};

export type AutoFixTask = {
  key: string;
  label: string;
  /** Problems-page section this task fully clears, when it has one. */
  sectionId?: string;
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
   *
   * Second way to reach zero: a section classed `coverage` in `PROBLEM_CLASS`
   * is excluded from `totalProblems`, so a task fixing one must return 0 here
   * even though it reads a real `AllProblems` array. All three non-zero tasks
   * below happen to be defect-classed today.
   */
  listedCount: (
    problems: AllProblems,
    counts: MaintenanceCounts | undefined,
  ) => number;
  /** Run alongside the others even at a zero/unknown count (idempotent tail steps). */
  alwaysRun?: boolean;
  run: () => Promise<AutoFixOutcome>;
  /**
   * Cache tags to invalidate once the WHOLE run finishes. Declared per task
   * rather than read off each descriptor because the button batches one
   * invalidation across every task it ran, and two of the six are held-open
   * streams with no `useMutation` to hang `meta` on.
   */
  invalidateTags?: InvalidationTagSet;
};

/**
 * The fixes the top-of-page "Fix" button runs — every Problems remedy that
 * needs no human judgment.
 *
 * Membership rule, so this list doesn't quietly grow teeth: a task belongs here
 * only if it is idempotent, non-destructive, and either instant or durable on
 * the queue. Deliberately absent, each for a stated reason:
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
const AUTO_FIX_TASKS: AutoFixTask[] = [
  {
    key: "cullPendingImages",
    label: "Cull abandoned uploads",
    count: (_problems, counts) => counts?.cullablePendingImages ?? null,
    // Abandoned uploads are maintenance, not a detected problem — there's no
    // Problems section for them, so none of this work is in `totalProblems`.
    listedCount: () => 0,
    invalidateTags: ripple.image,
    run: async () => {
      const r = await imageUpload.cullPendingImages.call({
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
    sectionId: "ai-descriptions",
    count: (problems) => problems.locationsWithoutAiDescription.length,
    // Its own section, uncapped.
    listedCount: (problems) => problems.locationsWithoutAiDescription.length,
    invalidateTags: ripple.location,
    run: async () => {
      const r = await collectBulkStream(
        await backfillLocationDescriptionsStream(),
      );
      return {
        summary: r.enqueued
          ? `queued ${pluralize("location", r.enqueued, true)} for analysis`
          : null,
      };
    },
  },
  {
    key: "missingEmbeddings",
    label: "Backfill search embeddings",
    sectionId: "missing-embeddings",
    // The Problems section only carries a sampled list, so the true figure comes
    // from the maintenance counts.
    count: (_problems, counts) => counts?.entitiesMissingEmbeddings ?? null,
    // The section is a capped sample, so only what's listed counts toward the
    // total — a model swap can make the true figure dwarf it.
    listedCount: (problems) => problems.entitiesMissingEmbeddings.length,
    invalidateTags: ripple.search,
    // Republishes every derived-data kind whose freshness marker is stale, not
    // just embeddings — there is no per-kind "just the embeddings" enqueue any
    // more (see `maintenance.settleAwaitingWork`), only this settle-everything
    // action, so the task's own count only reports the embedding slice of it.
    run: async () => {
      const r = await maintenance.settleAwaitingWork.call();
      return {
        summary: r.publishedEmbeddingTasks
          ? `published ${pluralize("embedding refresh", r.publishedEmbeddingTasks, true)}`
          : null,
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
    invalidateTags: ripple.recipeList,
    run: async () => {
      const r = await collectBulkStream(await openRecipeRecomputeStaleStream());
      return {
        summary: r.enqueued
          ? `queued ${pluralize("recipe", r.enqueued, true)} for recompute`
          : null,
      };
    },
  },
];

export const AUTO_FIX_SECTION_IDS = new Set(
  AUTO_FIX_TASKS.flatMap((task) => (task.sectionId ? [task.sectionId] : [])),
);

/**
 * Pure plan calculation shared by the button and summary. Keeping counting
 * separate from React/query state makes sampled-vs-maintenance totals testable.
 */
export function buildAutoFixPlan(
  problems: AllProblems,
  counts: MaintenanceCounts | undefined,
) {
  const counted = AUTO_FIX_TASKS.map((task) => ({
    task,
    count: task.count(problems, counts),
  }));
  const actionable = counted.filter((entry) => (entry.count ?? 0) > 0);
  return {
    items: sumBy(actionable, (entry) => entry.count ?? 0),
    listedItems: sumBy(actionable, (entry) =>
      entry.task.listedCount(problems, counts),
    ),
    // Tail steps ride along, but only when something else justified the run.
    tasks: actionable.length
      ? counted
          .filter((entry) => (entry.count ?? 0) > 0 || entry.task.alwaysRun)
          .map((entry) => entry.task)
      : [],
  };
}

import { CULL_PENDING_IMAGES_DEFAULT_HOURS } from "@cubby/schemas/image";
import {
  type AllProblems,
  type AutoFixProblemKey,
  type MaintenanceCounts,
  problemKeysSize,
} from "@cubby/schemas/problems";
import { countLabel } from "@cubby/shared/pluralize";
import { sumBy } from "es-toolkit";

import { openRecipeRecomputeStaleStream } from "~/features/recipe/recipe-streams";
import {
  ripple,
  type InvalidationTagSet,
} from "~/integrations/tanstack-query/cache-tags";
import {
  imageUpload,
  maintenance,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { backfillLocationDescriptionsStream } from "~/lib/ai-streams";
import { collectBulkStream } from "~/lib/bulk-progress";

/** What one task did, for the run's summary toast. */
type AutoFixOutcome = {
  /** Clause for the summary toast; null when the task turned out to be a no-op. */
  summary: string | null;
};

export type AutoFixTask = {
  key: string;
  label: string;
  /** Run alongside the others even at a zero/unknown count (idempotent tail steps). */
  alwaysRun?: boolean;
  run: () => Promise<AutoFixOutcome>;
  /**
   * Cache tags to invalidate once the WHOLE run finishes. Declared per task
   * rather than read off each descriptor because the button batches one
   * invalidation across every task it ran, and two of them are held-open
   * streams with no `useMutation` to hang `meta` on.
   */
  invalidateTags?: InvalidationTagSet;
} & (
  | {
      /**
       * The Problems detector this task clears in full. Its size is the
       * section's own count, so the Fix button and the "fix automatically"
       * headline are the same figure.
       */
      problemKey: AutoFixProblemKey;
      count?: never;
    }
  | {
      problemKey?: never;
      /**
       * Upkeep with no Problems section. `null` means "not countable" — such a
       * task only runs alongside one that counts (see `alwaysRun`). Never part
       * of the button's number, which promises only issues listed on the page.
       */
      count: (counts: MaintenanceCounts | undefined) => number | null;
    }
);

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
const AUTO_FIX_TASKS = [
  {
    key: "cullPendingImages",
    label: "Cull abandoned uploads",
    count: (counts) => counts?.cullablePendingImages ?? null,
    invalidateTags: ripple.image,
    run: async () => {
      const r = await imageUpload.cullPendingImages.call({
        olderThanHours: CULL_PENDING_IMAGES_DEFAULT_HOURS,
      });
      return {
        summary: r.count
          ? `culled ${countLabel(r.count, "pending image")}`
          : null,
      };
    },
  },
  {
    key: "locationDescriptions",
    label: "Analyze location photos",
    problemKey: "locationsWithoutAiDescription",
    invalidateTags: ripple.location,
    run: async () => {
      const r = await collectBulkStream(
        await backfillLocationDescriptionsStream(),
      );
      return {
        summary: r.enqueued
          ? `queued ${countLabel(r.enqueued, "location")} for analysis`
          : null,
      };
    },
  },
  {
    key: "missingEmbeddings",
    label: "Backfill search embeddings",
    problemKey: "entitiesMissingEmbeddings",
    invalidateTags: ripple.search,
    // Republishes every derived-data kind whose freshness marker is stale, not
    // just embeddings — there is no per-kind "just the embeddings" enqueue any
    // more (see `maintenance.settleAwaitingWork`), only this settle-everything
    // action, so the task's own count only reports the embedding slice of it.
    run: async () => {
      const r = await maintenance.settleAwaitingWork.call();
      return {
        summary: r.publishedEmbeddingTasks
          ? `published ${countLabel(r.publishedEmbeddingTasks, "embedding refresh")}`
          : null,
      };
    },
  },
  {
    key: "staleRecipeTotals",
    label: "Recompute stale recipe totals",
    // `staleRecipeTotals` is maintenance with no Problems section
    // (`staleParentRecipes` is a different, unrelated detector).
    count: (counts) => counts?.staleRecipeTotals ?? null,
    invalidateTags: ripple.recipeList,
    run: async () => {
      const r = await collectBulkStream(await openRecipeRecomputeStaleStream());
      return {
        summary: r.enqueued
          ? `queued ${countLabel(r.enqueued, "recipe")} for recompute`
          : null,
      };
    },
  },
] satisfies AutoFixTask[];

type MissingAutoFixTask = Exclude<
  AutoFixProblemKey,
  NonNullable<(typeof AUTO_FIX_TASKS)[number]["problemKey"]>
>;
// Every auto-fix detector needs a task, or the page would promise a Fix the
// button can't run.
const everyAutoFixKeyHasATask: [MissingAutoFixTask] extends [never]
  ? true
  : MissingAutoFixTask = true;
void everyAutoFixKeyHasATask;

/**
 * Pure plan calculation for the button. `issues` is the listed Problems the run
 * clears — the "fix automatically" headline; upkeep tasks ride along without
 * adding to it.
 */
export function buildAutoFixPlan(
  problems: AllProblems,
  counts: MaintenanceCounts | undefined,
) {
  const tasks: readonly AutoFixTask[] = AUTO_FIX_TASKS;
  const counted = tasks.map((task) => ({
    task,
    count: task.problemKey
      ? problemKeysSize(problems, [task.problemKey], problems.sectionTotals)
      : task.count(counts),
  }));
  const actionable = counted.filter((entry) => (entry.count ?? 0) > 0);
  return {
    issues: sumBy(
      actionable.filter((entry) => entry.task.problemKey),
      (entry) => entry.count ?? 0,
    ),
    // Tail steps ride along, but only when something else justified the run.
    tasks: actionable.length
      ? counted
          .filter((entry) => (entry.count ?? 0) > 0 || entry.task.alwaysRun)
          .map((entry) => entry.task)
      : [],
  };
}

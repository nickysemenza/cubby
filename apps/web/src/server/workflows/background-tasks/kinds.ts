import {
  locationAiDescriptionRefreshTaskSchema,
  locationAiInventoryRefreshTaskSchema,
  locationAiJobKey,
  runAiSummaryJobKey,
  runAiSummaryWriteTaskSchema,
  type BackgroundTask,
} from "@cubby/schemas/background-tasks";
import { runEntityId } from "@cubby/schemas/identifiers";
import type { z } from "zod";

import { aiRunOwner } from "~/server/ai/policy/call-owner";
import type { Database } from "~/server/db";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { Fenced, JobHandler } from "~/server/generic/jobs/types";
import { withJobFence } from "~/server/workflows/runs/execution";

type BackgroundTaskOutcome = "succeeded" | "skipped";

/** Embedding refresh publishes search documents in the caller's transaction; it never becomes a Job. */
export type JobBackgroundTask = Exclude<
  BackgroundTask,
  {
    kind:
      | "entity-embedding.refresh"
      | "calendar-feed.mark-dirty"
      | "maintenance.purchase-discovery";
  }
>;
type JobBackgroundTaskKind = JobBackgroundTask["kind"];

/**
 * One background task kind. `key` is the Job identity: re-admission under the
 * same key replaces queued work, so changing a key orphans queued rows.
 * `run` re-reads its subject's freshness marker and reports `skipped` when
 * nothing is due, so duplicate and out-of-order delivery stay harmless.
 * Handler modules load lazily so the request bundle never pulls in WASM or
 * vision clients.
 */
type BackgroundTaskKind<K extends JobBackgroundTaskKind> = {
  readonly schema: z.ZodType<Extract<JobBackgroundTask, { kind: K }>>;
  readonly key: (task: Extract<JobBackgroundTask, { kind: K }>) => string;
  /** Paid provider work checks its lease before each request and fences its publication. */
  readonly providerFenced?: true;
  readonly run: (
    db: Database,
    task: Extract<JobBackgroundTask, { kind: K }>,
    fenced: Fenced,
  ) => Promise<BackgroundTaskOutcome>;
};

const taskRunOwner = (task: { runId?: string | undefined }) =>
  aiRunOwner(task.runId ? runEntityId.parse(task.runId) : null);

async function locationVision<T>(
  analyze: (
    vision: typeof import("~/server/ai/enrichment/location-vision"),
  ) => Promise<T>,
): Promise<BackgroundTaskOutcome> {
  const vision = await import("~/server/ai/enrichment/location-vision");
  try {
    await analyze(vision);
  } catch (error) {
    if (vision.isLocationHasNoImagesToAnalyzeError(error)) return "skipped";
    throw error;
  }
  return "succeeded";
}

const BACKGROUND_TASK_KINDS = {
  "location-ai.description.refresh": {
    schema: locationAiDescriptionRefreshTaskSchema,
    key: (task) => locationAiJobKey(task.kind, task.locationId),
    providerFenced: true,
    run: (db, task, fenced) =>
      locationVision((vision) =>
        vision.describeLocation(
          db,
          task.locationId,
          taskRunOwner(task),
          undefined,
          fenced,
        ),
      ),
  },
  "location-ai.inventory.refresh": {
    schema: locationAiInventoryRefreshTaskSchema,
    key: (task) => locationAiJobKey(task.kind, task.locationId),
    providerFenced: true,
    run: (db, task, fenced) =>
      locationVision((vision) =>
        vision.detectInventoryItems(
          db,
          task.locationId,
          taskRunOwner(task),
          undefined,
          undefined,
          fenced,
        ),
      ),
  },
  "run-ai.summary.write": {
    schema: runAiSummaryWriteTaskSchema,
    key: (task) => runAiSummaryJobKey(task.subjectRunId, task.endedAt),
    providerFenced: true,
    run: async (db, task, fenced) => {
      const { writeRunSummary } =
        await import("~/server/domains/run/service/run-summary");
      return writeRunSummary(db, task, fenced);
    },
  },
} satisfies {
  readonly [K in JobBackgroundTaskKind]: BackgroundTaskKind<K>;
};

const declarationOf = (kind: JobBackgroundTaskKind) =>
  // SAFETY: each entry is declared for its own kind, and callers pass only
  // tasks or claims of that kind.
  BACKGROUND_TASK_KINDS[kind] as BackgroundTaskKind<JobBackgroundTaskKind>;

export const backgroundTaskJobKey = (task: JobBackgroundTask) =>
  declarationOf(task.kind).key(task);

function backgroundJobHandler(kind: JobBackgroundTaskKind): JobHandler {
  const declaration = declarationOf(kind);
  const handler = defineJobHandler(
    declaration.schema,
    async (db, _claim, task, context) => {
      const outcome = await declaration.run(db, task, context.fenced);
      return { page: { done: true, result: { outcome } } };
    },
  );
  if (!declaration.providerFenced) return handler;
  return {
    prepare: (db, job, context) =>
      withJobFence(context, () => handler.prepare(db, job, context)),
  };
}

// SAFETY: the keys come from the exhaustive declaration map.
const jobBackgroundTaskKinds = Object.keys(
  BACKGROUND_TASK_KINDS,
) as JobBackgroundTaskKind[];

// SAFETY: one handler per declared kind, keyed by that kind.
export const backgroundJobHandlers = Object.fromEntries(
  jobBackgroundTaskKinds.map((kind) => [kind, backgroundJobHandler(kind)]),
) as Record<JobBackgroundTaskKind, JobHandler>;

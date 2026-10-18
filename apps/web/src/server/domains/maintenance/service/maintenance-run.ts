import { RECIPE_RECOMPUTE_CHUNK_SIZE } from "@cubby/schemas/background-tasks";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  imageId,
  type ImageId,
  type RecipeId,
} from "@cubby/schemas/identifiers";
import type { RunStepError, RunStepMeta } from "@cubby/schemas/run-step";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import { z } from "zod";

import { roundTo } from "~/lib/round-to";
import { readAiBudget } from "~/server/ai/budget";
import {
  getAiGatewayEgress,
  getAppOrigin,
  isE2eAuthTestMode,
} from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  readImageProcessingJobStates,
  retryFailedImageProcessingJobs,
} from "~/server/domains/image-processing/repo/image-processing";
import { createImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-history";
import {
  ALL_IMAGE_PROCESSING_KINDS,
  countImagesMissingCurrentProcessing,
} from "~/server/domains/image-processing/repo/image-processing-maintenance";
import {
  backfillImageProcessing,
  repairImageProcessingWork,
} from "~/server/domains/image-processing/service/image-processing-maintenance";
import {
  clearImageMetadataOutcomes,
  countCullablePendingImages,
  countImagesStaleMetadata,
  cullPendingImageStorage,
  markImageMetadataOutcome,
  selectImagesForMetadataExtraction,
} from "~/server/domains/image/repo/image";
import {
  extractAndStoreImageMetadata,
  type ExtractImageMetadataPorts,
} from "~/server/domains/image/service/image-metadata-extraction.service";
import type {
  StepContext,
  StepDriver,
  StepRunDrivers,
} from "~/server/domains/run/service/step-run";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/generic/embedding/service/semantic/embeddings";
import {
  countUnembeddedSearchDocuments,
  selectUnembeddedSearchDocumentRefs,
  type SearchDocumentCursor,
} from "~/server/generic/search/repo/search-document";
import {
  type EmbeddingRefreshPort,
  productionEmbeddingRefreshPort,
  refreshEntityEmbeddings,
} from "~/server/workflows/background-tasks/embedding";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

/** Uploads abandoned after presign; the same threshold the presign cull uses. */
const PENDING_UPLOAD_HOURS = 24;
/** Inline EXIF attempts before a non-404 failure becomes `extraction_failed`. */
const EXIF_ATTEMPTS = 3;
const RETIRE_COORDINATORS_AFTER_MS = 24 * 60 * 60_000;

/** External seams a test replaces; everything else runs for real. */
export type MaintenancePorts = {
  metadata?: ExtractImageMetadataPorts;
  /** Runs one image-processing job now (cloud model or companion handoff). */
  dispatchImageJob?: (db: Database, jobId: string) => Promise<void>;
  embedding?: EmbeddingRefreshPort;
  pageSize?: { exif?: number; imageBackfill?: number };
};

const failureText = (error: unknown) =>
  runFailureText(error instanceof Error ? error : String(error));

const failure = (message: string, ref?: string): RunStepError => ({
  at: new Date().toISOString(),
  message,
  ...(ref && { ref }),
});

/** Every cause of a (possibly aggregate) failure, each as its own error. */
const failuresOf = (error: unknown): RunStepError[] =>
  error instanceof AggregateError
    ? error.errors.flatMap(failuresOf)
    : [failure(failureText(error))];

/** The refs a "Retry failed" re-admitted on this step, by prefix. */
const retryRefs = (context: StepContext, prefix: string) =>
  (context.step.meta?.retryErrors ?? []).flatMap((error) =>
    error.ref?.startsWith(prefix) ? [error.ref.slice(prefix.length)] : [],
  );

/** Consumed retry refs, so a later page drains normally. */
const RETRY_CONSUMED: RunStepMeta = { retryErrors: [] };

const detail = (values: Record<string, number | string | boolean>) => ({
  detail: values,
});

/** A step whose work is one bounded call; failures stay on the step. */
function onceStep(
  key: string,
  label: string,
  work: (context: StepContext) => Promise<{
    found: number;
    done?: number;
    errors?: RunStepError[];
    meta?: RunStepMeta;
    more?: boolean;
  }>,
): StepDriver {
  return {
    key,
    label,
    page: async (context) => {
      let outcome;
      try {
        outcome = await work(context);
      } catch (error) {
        const errors = failuresOf(error);
        return {
          kind: "progress",
          delta: { found: errors.length, failed: errors.length },
          errors,
          done: true,
        };
      }
      const failed = outcome.errors?.length ?? 0;
      return {
        kind: "progress",
        delta: {
          found: outcome.found + failed,
          done: outcome.done ?? outcome.found,
          failed,
        },
        ...(outcome.errors?.length && { errors: outcome.errors }),
        ...(outcome.meta && { meta: outcome.meta }),
        done: !outcome.more,
      };
    },
  };
}

const imageRef = (id: string) => `image:${id}`;

function exifStep(ports: MaintenancePorts): StepDriver {
  const pageSize = ports.pageSize?.exif ?? 50;
  return {
    key: "exif",
    label: "EXIF/GPS extraction",
    page: async (context) => {
      const { db, step } = context;
      const retried = retryRefs(context, "image:").map((id) =>
        imageId.parse(id),
      );
      const readmitted = retried.length
        ? await clearImageMetadataOutcomes(db, retried)
        : [];
      if (retried.length) {
        const counts = await extractImages(db, readmitted, ports);
        // A ref someone else already re-admitted or fixed is not retried.
        counts.delta.skipped += retried.length - readmitted.length;
        return {
          kind: "progress",
          delta: counts.delta,
          errors: counts.errors,
          meta: RETRY_CONSUMED,
          done: true,
        };
      }
      const cursor = z
        .object({ createdAt: z.string(), id: z.string() })
        .nullable()
        .parse(step.cursor ?? null);
      const rows = await selectImagesForMetadataExtraction(
        db,
        pageSize,
        cursor,
      );
      const counts = await extractImages(
        db,
        rows.map((row) => row.id),
        ports,
      );
      const processed = step.done + step.failed + step.skipped + rows.length;
      return {
        kind: "progress",
        delta: counts.delta,
        // Found is what this pass handled plus what is still waiting.
        found:
          processed + (rows.length ? await countImagesStaleMetadata(db) : 0),
        errors: counts.errors,
        cursor: rows.at(-1)?.cursor ?? cursor,
        done: rows.length < pageSize,
      };
    },
  };
}

/**
 * Extracts each image with bounded inline retries. A 404 is terminal at once
 * (`original_missing`); any other failure becomes `extraction_failed` after
 * the last attempt. Either way the row leaves the backlog with its raw error.
 */
async function extractImages(
  db: Database,
  ids: readonly ImageId[],
  ports: MaintenancePorts,
) {
  const delta = { done: 0, failed: 0, skipped: 0 };
  const errors: RunStepError[] = [];
  for (const id of ids) {
    let lastError: unknown;
    let settled = false;
    for (let attempt = 1; attempt <= EXIF_ATTEMPTS && !settled; attempt++) {
      try {
        const outcome = await extractAndStoreImageMetadata(
          db,
          id,
          ports.metadata,
        );
        settled = true;
        if (outcome === "succeeded") delta.done += 1;
        else if (outcome === "skipped") delta.skipped += 1;
        else {
          delta.failed += 1;
          errors.push(failure(outcome.missing, imageRef(id)));
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (settled) continue;
    const message = `EXIF/GPS extraction failed after ${EXIF_ATTEMPTS} attempts: ${failureText(lastError)}`;
    await markImageMetadataOutcome(db, id, "extraction_failed", message);
    delta.failed += 1;
    errors.push(failure(message, imageRef(id)));
  }
  return { delta, errors };
}

const searchDocumentRef = (kind: string, id: string) =>
  `searchDocument:${entityRefKey(searchableEntitySchema.parse(kind), id)}`;

function embeddingsStep(ports: MaintenancePorts): StepDriver {
  const port = ports.embedding ?? productionEmbeddingRefreshPort;
  return {
    key: "embeddings",
    label: "Search embeddings",
    page: async (context) => {
      const { db, step } = context;
      if (!port.configured()) return { kind: "progress", found: 0, done: true };
      const config = getSemanticEmbeddingConfig();
      const retried = retryRefs(context, "searchDocument:").flatMap((key) => {
        const [entityKind, entityId] = key.split(":");
        const kind = searchableEntitySchema.safeParse(entityKind);
        return kind.success && entityId
          ? [{ entityKind: kind.data, entityId }]
          : [];
      });
      const cursor =
        z
          .object({ entityKind: searchableEntitySchema, entityId: z.string() })
          .nullable()
          .parse(step.cursor ?? null) ?? undefined;
      const page = retried.length
        ? { refs: retried, nextCursor: null }
        : await selectUnembeddedSearchDocumentRefs(db, config, {
            cursor,
            pageSize: 100,
          });
      const results = await refreshEntityEmbeddings(db, page.refs, port);
      const delta = { done: 0, failed: 0, skipped: 0 };
      const errors: RunStepError[] = [];
      for (const ref of page.refs) {
        const result = results.get(entityRefKey(ref.entityKind, ref.entityId));
        if (!result || "error" in result) {
          delta.failed += 1;
          errors.push(
            failure(
              result
                ? failureText(result.error)
                : "No embedding refresh result",
              searchDocumentRef(ref.entityKind, ref.entityId),
            ),
          );
        } else if (result.outcome === "written") delta.done += 1;
        else delta.skipped += 1;
      }
      if (retried.length)
        return {
          kind: "progress",
          delta,
          errors,
          meta: RETRY_CONSUMED,
          done: true,
        };
      const processed =
        step.done + step.failed + step.skipped + page.refs.length;
      return {
        kind: "progress",
        delta,
        found:
          processed +
          (page.nextCursor
            ? // Failed refs behind the cursor stay unembedded until a retry.
              Math.max(
                (await countUnembeddedSearchDocuments(db, config)) -
                  step.failed -
                  delta.failed,
                0,
              )
            : 0),
        errors,
        cursor: page.nextCursor ?? cursor ?? null,
        done: !page.nextCursor,
      };
    },
  };
}

const recipeTotalsStep: StepDriver = {
  key: "recipe-totals",
  label: "Recipe totals",
  page: async ({ db, step }) => {
    const { selectAllStaleRecipeIds, selectStaleRecipeIds } =
      await import("~/server/domains/recipe/repo/totals");
    const after = z
      .string()
      .nullable()
      .parse(step.cursor ?? null);
    const stale = (await selectAllStaleRecipeIds(db))
      .filter((id) => !after || id > after)
      .sort();
    const chunk = stale.slice(0, RECIPE_RECOMPUTE_CHUNK_SIZE);
    if (!chunk.length) return { kind: "progress", delta: {}, done: true };
    const { buildCrudServices } = await import("~/server/http/request-context");
    const errors: RunStepError[] = [];
    let stillStale: RecipeId[] = [];
    try {
      await buildCrudServices(db).services.recipeCosting.recomputeQueued(chunk);
      stillStale = await selectStaleRecipeIds(db, chunk);
    } catch (error) {
      const message = failureText(error);
      for (const id of chunk) errors.push(failure(message, `recipe:${id}`));
    }
    const done = errors.length ? 0 : chunk.length - stillStale.length;
    return {
      kind: "progress",
      found: step.done + step.failed + step.skipped + stale.length,
      delta: {
        done,
        failed: errors.length,
        skipped: errors.length ? 0 : stillStale.length,
      },
      errors,
      cursor: chunk.at(-1) ?? after,
      done: stale.length <= chunk.length,
    };
  },
};

function imageBackfillStep(ports: MaintenancePorts): StepDriver {
  const pageSize = ports.pageSize?.imageBackfill ?? 5;
  const dispatch =
    ports.dispatchImageJob ??
    (async (db: Database, jobId: string) => {
      const { dispatchImageProcessingWakeup } =
        await import("~/server/domains/image-processing/service/dispatch");
      await dispatchImageProcessingWakeup(db, jobId);
    });
  return {
    key: "image-backfill",
    label: "Image processing backfill",
    page: async (context) => {
      const { db, step, run } = context;
      // Paid describe/identify calls stop at the frontier-model budget; the
      // Run pauses until the window ends and resumes from this cursor.
      const budget = await readAiBudget(db);
      if (budget.spentUsd >= budget.limitUsd)
        return {
          kind: "paused",
          reason: `AI budget used for this window ($${roundTo(budget.spentUsd, 2)} of $${budget.limitUsd})`,
          until: new Date(budget.windowEnd),
        };
      const retried = retryRefs(context, "image:").map((id) =>
        imageId.parse(id),
      );
      if (retried.length) {
        const submission = await createImageProcessingSubmission(db);
        const images = [];
        for (const retriedId of retried)
          images.push({
            id: retriedId,
            jobIds: await retryFailedImageProcessingJobs(db, 100, {
              imageId: retriedId,
              submissionId: submission.id,
            }),
          });
        const counts = await dispatchImages(db, images, dispatch);
        return {
          kind: "progress",
          delta: counts.delta,
          errors: counts.errors,
          meta: RETRY_CONSUMED,
          done: true,
        };
      }
      const cursor = z
        .object({ createdAt: z.string(), id: z.string() })
        .nullable()
        .parse(step.cursor ?? null);
      const scheduled = await backfillImageProcessing(db, {
        batchSize: pageSize,
        after: cursor,
        runId: run.id,
        publish: false,
      });
      const counts = await dispatchImages(db, scheduled.images, dispatch);
      const processed =
        step.done + step.failed + step.skipped + scheduled.images.length;
      return {
        kind: "progress",
        delta: counts.delta,
        found:
          processed +
          (scheduled.images.length
            ? // Images that got no job stay missing behind the cursor.
              Math.max(
                (await countImagesMissingCurrentProcessing(
                  db,
                  ALL_IMAGE_PROCESSING_KINDS,
                )) -
                  step.skipped -
                  counts.delta.skipped,
                0,
              )
            : 0),
        errors: counts.errors,
        cursor: scheduled.images.at(-1)?.cursor ?? cursor,
        done: scheduled.images.length < pageSize,
      };
    },
  };
}

/** Runs each image's jobs now; an image fails when any of its jobs failed. */
async function dispatchImages(
  db: Database,
  images: ReadonlyArray<{ id: string; jobIds: readonly string[] }>,
  dispatch: (db: Database, jobId: string) => Promise<void>,
) {
  const delta = { done: 0, failed: 0, skipped: 0 };
  const errors: RunStepError[] = [];
  const jobIds = images.flatMap((candidate) => candidate.jobIds);
  for (const jobId of jobIds) await dispatch(db, jobId);
  const states = await readImageProcessingJobStates(db, jobIds);
  const byId = new Map(states.map((row) => [row.id, row]));
  for (const candidate of images) {
    if (!candidate.jobIds.length) {
      delta.skipped += 1;
      continue;
    }
    const failed = candidate.jobIds
      .map((jobId) => byId.get(jobId))
      .filter((row) => row?.state === "failed");
    if (!failed.length) {
      delta.done += 1;
      continue;
    }
    delta.failed += 1;
    errors.push(
      failure(
        failed.map((row) => row?.lastError ?? "Image job failed").join("\n"),
        imageRef(candidate.id),
      ),
    );
  }
  return { delta, errors };
}

/**
 * One driver per backlog, in order. The paid image backfill is last: a budget
 * pause stops the whole Run, so every free backlog drains before it.
 */
export function maintenanceSteps(ports: MaintenancePorts = {}): StepDriver[] {
  return [
    onceStep("ai-refresh", "AI refresh observation", async () => {
      const egress = getAiGatewayEgress(CUBBY_AI_GATEWAY_ID);
      if (import.meta.env.CUBBY_LOCAL_RUNTIME || isE2eAuthTestMode() || !egress)
        return { found: 0, meta: detail({ observed: false }) };
      await egress.observeAiRefresh();
      return { found: 0, meta: detail({ observed: true }) };
    }),
    onceStep("image-repair", "Image processing repair", async ({ db }) => {
      const repaired = await repairImageProcessingWork(db);
      const found =
        repaired.orphans +
        repaired.executorless +
        repaired.leases +
        repaired.dispatch;
      return {
        found,
        more: repaired.more,
        meta: detail({
          orphans: repaired.orphans,
          executorless: repaired.executorless,
          leases: repaired.leases,
          wakeups: repaired.dispatch,
        }),
      };
    }),
    exifStep(ports),
    embeddingsStep(ports),
    recipeTotalsStep,
    onceStep("pending-uploads", "Abandoned uploads", async ({ db }) => {
      const found = await countCullablePendingImages(db, PENDING_UPLOAD_HOURS);
      if (!found) return { found: 0 };
      const culled = await cullPendingImageStorage(db, PENDING_UPLOAD_HOURS);
      return {
        found,
        done: culled.count,
        more: culled.count > 0 && culled.count < found,
      };
    }),
    onceStep("photo-runs", "Photo Run advance", async ({ db }) => {
      const { advanceWaitingPhotoRuns } =
        await import("~/server/domains/photo-import/repo/run/lifecycle");
      return { found: await advanceWaitingPhotoRuns(db) };
    }),
    onceStep("coordinators", "Coordinator retirement", async ({ db }) => {
      const { retireCoordinators } =
        await import("~/server/workflows/catch-up");
      const retired = await retireCoordinators(
        db,
        new Date(Date.now() - RETIRE_COORDINATORS_AFTER_MS),
      );
      return { found: retired?.retired ?? 0 };
    }),
    onceStep("runs", "Stale and routine Runs", async ({ db }) => {
      const { maintainRunHistory } =
        await import("~/server/workflows/catch-up");
      const history = await maintainRunHistory(db);
      return {
        // Pruned history is not backlog: counting it would keep every pass
        // that prunes from ever being routine itself.
        found: history.expired + history.reconciled,
        errors: history.failures.map((entry) =>
          failure(
            `Stale Run could not be moved to review: ${entry.error}`,
            `run:${entry.runId}`,
          ),
        ),
        meta: detail({
          expired: history.expired,
          reconciled: history.reconciled,
          pruned: history.pruned,
        }),
      };
    }),
    onceStep("original-disposal", "Email original disposal", async ({ db }) => {
      const [
        { disposeUnrelatedOriginals, disposeExpiredSearchOriginals },
        { productionOrderMailAttachmentStorage },
      ] = await Promise.all([
        import("~/server/domains/purchase-import/repo/gmail/persistence"),
        import("~/server/domains/purchase-import/repo/gmail/attachment-storage"),
      ]);
      const results = await Promise.allSettled([
        disposeUnrelatedOriginals(db, productionOrderMailAttachmentStorage),
        disposeExpiredSearchOriginals(db, productionOrderMailAttachmentStorage),
      ]);
      return {
        found: results.reduce(
          (total, result) =>
            total + (result.status === "fulfilled" ? result.value : 0),
          0,
        ),
        errors: results.flatMap((result) =>
          result.status === "rejected" ? failuresOf(result.reason) : [],
        ),
      };
    }),
    onceStep("vector-reconcile", "Vector reconcile", async ({ db }) => {
      if (!semanticEmbeddingsConfigured())
        return { found: 0, meta: detail({ deleted: 0 }) };
      const [
        { selectRecentlySoftDeletedSearchRefs },
        { productionVectorStore },
      ] = await Promise.all([
        import("~/server/generic/embedding/repo/entity-embedding-cleanup"),
        import("~/server/generic/embedding/service/semantic/vector-store"),
      ]);
      // Vectorize cannot join the transaction that soft-deletes a document,
      // so a removed entity's vector is deleted here; `deleteByIds` is
      // idempotent, which is why re-deleted refs are not counted as backlog.
      const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
      let cursor: SearchDocumentCursor | undefined;
      let deleted = 0;
      do {
        const page = await selectRecentlySoftDeletedSearchRefs(db, {
          since,
          cursor,
        });
        if (page.refs.length) {
          await productionVectorStore.deleteByIds(page.refs);
          deleted += page.refs.length;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { found: 0, meta: detail({ deleted }) };
    }),
    onceStep("calendar", "Calendar refresh", async () => {
      const origin = getAppOrigin();
      if (!origin) return { found: 0, meta: detail({ refreshed: false }) };
      const { calendarFeedStateFor } =
        await import("~/server/domains/calendar/repo/client");
      await (await calendarFeedStateFor(origin)).refreshNow("cron.daily");
      return { found: 0, meta: detail({ refreshed: true }) };
    }),
    onceStep("mail-discovery", "Mail discovery", async ({ db }) => {
      // Each mailbox's pass is its own `mail_discovery` Run with its own
      // history; this step only starts them, so it is never backlog.
      const { discoverPurchases } = await import("~/server/workflows/catch-up");
      try {
        const { mail } = await discoverPurchases(db);
        return {
          found: 0,
          meta: detail({
            started: mail?.started ?? 0,
            running: mail?.running ?? 0,
            configured: mail !== null,
          }),
        };
      } catch (error) {
        if (!(error instanceof AggregateError)) throw error;
        return { found: 0, errors: failuresOf(error) };
      }
    }),
    imageBackfillStep(ports),
  ];
}

export const maintenanceDrivers: StepRunDrivers = async () =>
  maintenanceSteps();

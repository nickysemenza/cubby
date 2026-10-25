import { imageId, type ImageId } from "@cubby/schemas/identifiers";
import type { RunStepError, RunStepMeta } from "@cubby/schemas/run-step";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { z } from "zod";

import { getAppOrigin } from "~/server/cf-env";
import type { Database } from "~/server/db";
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
  pendingCullCutoff,
  selectImagesForMetadataExtraction,
} from "~/server/domains/image/repo/image";
import {
  extractAndStoreImageMetadata,
  type ExtractImageMetadataPorts,
} from "~/server/domains/image/service/image-metadata-extraction.service";
import type { StepDriversFor } from "~/server/domains/run/service/run-step-registry";
import type {
  StepContext,
  StepDriver,
} from "~/server/domains/run/service/step-run";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

/** Uploads abandoned after presign; the same threshold the presign cull uses. */
const PENDING_UPLOAD_HOURS = 24;
/** Inline EXIF attempts before a non-404 failure becomes `extraction_failed`. */
const EXIF_ATTEMPTS = 3;
const RETIRE_COORDINATORS_AFTER_MS = 24 * 60 * 60_000;

/** External seams a test replaces; everything else runs for real. */
export type MaintenancePorts = {
  metadata?: ExtractImageMetadataPorts;
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
  (context.step.meta?.retryRefs ?? []).flatMap((ref) =>
    ref.startsWith(prefix) ? [ref.slice(prefix.length)] : [],
  );

/** Consumed retry refs, so a later page drains normally. */
const RETRY_CONSUMED: RunStepMeta = { retryRefs: [] };

const detail = (values: Record<string, number | string | boolean>) => ({
  detail: values,
});

/**
 * A step whose work is one bounded call (a `tally` step: it has no stored
 * population to count); failures stay on the step.
 */
function onceStep(
  work: (context: StepContext) => Promise<{
    done: number;
    errors?: RunStepError[];
    meta?: Pick<RunStepMeta, "detail">;
    more?: boolean;
  }>,
): StepDriver {
  return {
    page: async (context) => {
      let outcome;
      try {
        outcome = await work(context);
      } catch (error) {
        const errors = failuresOf(error);
        return {
          kind: "progress",
          delta: { failed: errors.length },
          errors,
          done: true,
        };
      }
      return {
        kind: "progress",
        delta: { done: outcome.done, failed: outcome.errors?.length ?? 0 },
        ...(outcome.errors?.length && { errors: outcome.errors }),
        ...(outcome.meta && { meta: outcome.meta }),
        done: !outcome.more,
      };
    },
  };
}

const SEARCH_CLEANUP_PAGE = 200;
const searchCleanupCursor = z
  .object({
    phase: z.enum(["documents", "vectors"]),
    entityKind: searchableEntitySchema.optional(),
    entityId: z.uuid().optional(),
    after: z.string().optional(),
  })
  .nullable();

/** Retire orphaned search documents, then queue retired embedding vectors for deletion. */
function searchArtifactCleanupStep(): StepDriver {
  return {
    page: async ({ db, step }) => {
      const cursor = searchCleanupCursor.parse(step.cursor ?? null) ?? {
        phase: "documents" as const,
      };
      if (cursor.phase === "documents") {
        const [
          { getSearchDocumentOrphanPage },
          { retireStillOrphanedSearchArtifacts },
        ] = await Promise.all([
          import("~/server/generic/search/repo/search-document"),
          import("~/server/generic/embedding/repo/entity-embedding-cleanup"),
        ]);
        const page = await getSearchDocumentOrphanPage(db, {
          cursor:
            cursor.entityKind && cursor.entityId
              ? { entityKind: cursor.entityKind, entityId: cursor.entityId }
              : undefined,
          pageSize: SEARCH_CLEANUP_PAGE,
        });
        const retired = await retireStillOrphanedSearchArtifacts(db, page.refs);
        return {
          kind: "progress",
          delta: { done: retired },
          cursor: page.nextCursor
            ? { phase: "documents", ...page.nextCursor }
            : { phase: "vectors" },
          done: false,
        };
      }
      const { queueEmbeddingCleanupPage } =
        await import("~/server/generic/embedding/repo/embedding-cleanup");
      const page = await queueEmbeddingCleanupPage(
        db,
        cursor.after,
        SEARCH_CLEANUP_PAGE,
      );
      return {
        kind: "progress",
        delta: { done: page.queued },
        ...(page.nextCursor
          ? { cursor: { phase: "vectors", after: page.nextCursor } }
          : {}),
        done: !page.nextCursor,
      };
    },
  };
}

const imageRef = (id: string) => `image:${id}`;

function exifStep(
  ports: MaintenancePorts,
): StepDriversFor<"maintenance">["exif"] {
  const pageSize = ports.pageSize?.exif ?? 50;
  return {
    count: async ({ db }) => {
      // The keyset cursor walks the backlog once under this cutoff; rows
      // that leave it end `removed`, later uploads wait for the next pass.
      const boundary = new Date().toISOString();
      return {
        total: await countImagesStaleMetadata(db, boundary),
        boundary,
      };
    },
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
        z.iso.datetime().nullable().parse(context.boundary),
      );
      const counts = await extractImages(
        db,
        rows.map((row) => row.id),
        ports,
      );
      return {
        kind: "progress",
        delta: counts.delta,
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

function imageBackfillStep(ports: MaintenancePorts): StepDriver {
  const pageSize = ports.pageSize?.imageBackfill ?? 5;
  return {
    page: async ({ db, step, run }) => {
      const after = z
        .object({ createdAt: z.string(), id: z.string() })
        .nullable()
        .parse(step.cursor ?? null);
      const page = await backfillImageProcessing(db, {
        batchSize: pageSize,
        after,
        runId: run.id,
      });
      const last = page.images.at(-1);
      return {
        kind: "progress",
        delta: { done: page.scheduled },
        ...(last ? { cursor: last.cursor } : {}),
        done: page.images.length < pageSize,
      };
    },
  };
}

/**
 * One driver per declared maintenance step (`RUN_KINDS.maintenance`); the
 * manifest owns their order. The paid image backfill is last: a budget pause
 * stops the whole Run, so every free backlog drains before it.
 */
export function maintenanceStepDrivers(
  ports: MaintenancePorts = {},
): StepDriversFor<"maintenance"> {
  return {
    "image-repair": onceStep(async ({ db }) => {
      const repaired = await repairImageProcessingWork(db);
      return {
        done: repaired.orphans + repaired.executorless,
        more: repaired.more,
        meta: detail({
          orphans: repaired.orphans,
          executorless: repaired.executorless,
        }),
      };
    }),
    exif: exifStep(ports),
    "pending-uploads": {
      // The age cutoff is fixed when the step counts, so the cull removes the
      // counted uploads rather than ones that aged past it since.
      count: async ({ db }) => {
        const before = pendingCullCutoff(PENDING_UPLOAD_HOURS);
        return {
          total: await countCullablePendingImages(
            db,
            PENDING_UPLOAD_HOURS,
            before,
          ),
          boundary: before.toISOString(),
        };
      },
      page: async ({ db, step, boundary }) => {
        if (!step.found) return { kind: "progress", done: true };
        const before = z.iso.datetime().nullable().parse(boundary);
        const culled = await cullPendingImageStorage(
          db,
          PENDING_UPLOAD_HOURS,
          before ? new Date(before) : undefined,
        );
        return {
          kind: "progress",
          delta: { done: culled.count },
          done: culled.count === 0 || step.done + culled.count >= step.found,
        };
      },
    },
    "photo-runs": onceStep(async ({ db }) => {
      const { advanceWaitingPhotoRuns } =
        await import("~/server/domains/photo-import/repo/run/lifecycle");
      return { done: await advanceWaitingPhotoRuns(db) };
    }),
    coordinators: onceStep(async ({ db }) => {
      const { retireCoordinators } =
        await import("~/server/workflows/catch-up");
      const retired = await retireCoordinators(
        db,
        new Date(Date.now() - RETIRE_COORDINATORS_AFTER_MS),
      );
      return { done: retired?.retired ?? 0 };
    }),
    runs: onceStep(async ({ db }) => {
      const { maintainRunHistory } =
        await import("~/server/workflows/catch-up");
      const history = await maintainRunHistory(db);
      return {
        done: history.expired + history.reconciled,
        errors: history.failures.map((entry) =>
          failure(
            `Stale Run could not be moved to review: ${entry.error}`,
            `run:${entry.runId}`,
          ),
        ),
        meta: detail({
          expired: history.expired,
          reconciled: history.reconciled,
        }),
      };
    }),
    "original-disposal": onceStep(async ({ db }) => {
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
        done: results.reduce(
          (total, result) =>
            total + (result.status === "fulfilled" ? result.value : 0),
          0,
        ),
        errors: results.flatMap((result) =>
          result.status === "rejected" ? failuresOf(result.reason) : [],
        ),
      };
    }),
    // Derived values reconcile through their own hourly buckets (ADR 0021);
    // this step owns the search artifacts no mark reaches: documents of
    // records removed before their triggers existed, and retired vectors.
    "derived-refresh": searchArtifactCleanupStep(),
    calendar: onceStep(async () => {
      const origin = getAppOrigin();
      if (!origin) return { done: 0, meta: detail({ refreshed: false }) };
      const { calendarFeedStateFor } =
        await import("~/server/domains/calendar/repo/client");
      await (await calendarFeedStateFor(origin)).refreshNow("cron.daily");
      return { done: 0, meta: detail({ refreshed: true }) };
    }),
    "mail-discovery": onceStep(async ({ db }) => {
      // Each mailbox's pass is its own `mail_discovery` Run with its own
      // history; this step only starts them, so it is never backlog.
      const { discoverPurchases } = await import("~/server/workflows/catch-up");
      try {
        const { mail } = await discoverPurchases(db);
        return {
          done: 0,
          meta: detail({
            started: mail?.started ?? 0,
            running: mail?.running ?? 0,
            configured: mail !== null,
          }),
        };
      } catch (error) {
        if (!(error instanceof AggregateError)) throw error;
        return { done: 0, errors: failuresOf(error) };
      }
    }),
    "image-backfill": imageBackfillStep(ports),
  };
}

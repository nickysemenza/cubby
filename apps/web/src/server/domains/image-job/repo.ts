import {
  ACTIVITY_KIND_LABEL,
  imageProcessingJobKind,
} from "@cubby/schemas/activity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  type ImageJobFilters,
  type ImageJobOut,
  imageJobOut,
} from "@cubby/schemas/image-job";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq, sql } from "drizzle-orm";

import type { ListReadRow } from "~/entity/model/list-read-fields";
import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { imageProcessingJob } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  createEntityReader,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { hydrateListRead } from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
} from "../image-processing/repo/image-processing";

type ImageJobRow = typeof imageProcessingJob.$inferSelect;

const scaffold = listScaffold("imageJob", imageProcessingJob, {
  derived: {
    // A job joins every submission that scheduled or retried it, not only
    // its first.
    submissionId: (submissionId) => sql`${imageProcessingJob.id} IN (
        SELECT membership."jobId"
        FROM "ImageProcessingSubmissionJob" membership
        JOIN "ImageProcessingSubmission" submission ON submission.id = membership."submissionId"
        WHERE submission."publicId" = ${submissionId}
      )`,
  },
});

type Facts = {
  chargedCost: number;
  standardCost: number;
  lastExecutor: string | null;
  deviceRan: boolean;
};

/**
 * AI usage is billed per attempt (`image_processing_attempt`) and, for older
 * rows, per job kind; both belong to the job.
 */
const loadFacts = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
): Promise<Map<string, Facts>> => {
  if (ids.length === 0) return new Map();
  const result = await unwrapDb(db).execute<{
    id: string;
    charged: string | number | null;
    standard: string | number | null;
    executor: string | null;
    deviceRan: boolean;
  }>(sql`
    SELECT j.id,
      (SELECT coalesce(sum(u."chargedCost"), 0) FROM "AiUsage" u
        WHERE u."deletedAt" IS NULL AND (
          (u."jobKind" = ${"image_processing_attempt"} AND u."jobId" IN (
            SELECT a.id::text FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id))
          OR (u."jobKind" = j.kind AND u."jobId" = j.id::text))) AS charged,
      (SELECT coalesce(sum(u."standardCost"), 0) FROM "AiUsage" u
        WHERE u."deletedAt" IS NULL AND (
          (u."jobKind" = ${"image_processing_attempt"} AND u."jobId" IN (
            SELECT a.id::text FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id))
          OR (u."jobKind" = j.kind AND u."jobId" = j.id::text))) AS standard,
      coalesce(
        (SELECT a.executor->>${"name"} FROM "ImageProcessingAttempt" a
          WHERE a."jobId" = j.id AND a.executor IS NOT NULL
          ORDER BY a.number DESC LIMIT 1),
        CASE WHEN (j.kind = ${imageProcessingJobKind.enum.describe_image} AND j."processorRevision" = ${IMAGE_DESCRIPTION_PROCESSOR_REVISION})
          OR (j.kind = ${imageProcessingJobKind.enum.identify_image} AND j."processorRevision" = ${IMAGE_IDENTIFICATION_PROCESSOR_REVISION})
          THEN 'AI Gateway' END
      ) AS executor,
      EXISTS (SELECT 1 FROM "ImageProcessingAttempt" a
        WHERE a."jobId" = j.id AND a.executor->>${"kind"} = ${"device"}) AS "deviceRan"
    FROM "ImageProcessingJob" j
    WHERE j.id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        chargedCost: Number(row.charged ?? 0),
        standardCost: Number(row.standard ?? 0),
        lastExecutor: row.executor,
        deviceRan: row.deviceRan,
      },
    ]),
  );
};

/**
 * A skipped job's stored reason is a code; the household reads what Apple
 * decided, or that an older policy skipped it. Stored diagnostics stay intact.
 */
const issueText = (row: ImageJobRow, deviceRan: boolean) => {
  if (row.state !== "skipped") return row.lastError;
  switch (row.lastError) {
    case "no_subject":
      return "Apple found no foreground subject.";
    case "unsupported_format":
      return "Apple cannot process this image format.";
    case "not_suitable":
      return deviceRan
        ? "The image already has a transparent background."
        : "The previous cloud eligibility policy skipped subject lift. Queue missing processing to retry.";
    case "Image is attached only as label evidence":
      return "The previous label-only policy skipped subject lift. Queue missing processing to retry.";
    default:
      return row.lastError;
  }
};

const hydrateRead = (
  db: Database | DrizzleTransaction,
  rows: ImageJobRow[],
  projection: ListProjection,
): Promise<ListReadRow[]> =>
  hydrateListRead(db, "imageJob", rows, projection, {
    media: true,
    load: () =>
      Promise.all([
        lookupEntityReferences(
          db,
          "image",
          rows.map((row) => row.imageId),
          { includeDeleted: true },
        ),
        lookupEntityReferences(
          db,
          "run",
          rows.map((row) => row.runId),
          { includeDeleted: true },
        ),
        loadFacts(
          db,
          rows.map((row) => row.id),
        ),
      ]),
    mapRow: (row, { loaded: [images, runs, facts], displayImages }) => {
      const image = images.get(row.imageId);
      if (!image) throw new Error("Image job's Image reference is missing");
      const fact = facts.get(row.id);
      const kind = imageProcessingJobKind.parse(row.kind);
      return {
        ...row,
        id: parseShortcodeFor("imageJob", row.shortcode),
        displayName: `${ACTIVITY_KIND_LABEL[kind]} · ${image.name ?? image.id}`,
        imageId: image.id,
        runId: row.runId === null ? null : (runs.get(row.runId)?.id ?? null),
        durationMs:
          row.completedAt && row.dispatchedAt
            ? Math.max(
                0,
                row.completedAt.getTime() - row.dispatchedAt.getTime(),
              )
            : null,
        chargedCost: fact?.chargedCost ?? 0,
        standardCost: fact?.standardCost ?? 0,
        lastExecutor: fact?.lastExecutor ?? null,
        lastError: issueText(row, fact?.deviceRan ?? false),
        displayImages,
      };
    },
  });

export const listImageJobsRead = (
  db: Database,
  filters: ImageJobFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      hydrate: (rows, selected) => hydrateRead(db, rows, selected),
    },
  );

const listImageJobs = completeListReader(imageJobOut, listImageJobsRead);

const reader = createEntityReader<
  ImageJobRow,
  ImageJobOut,
  "imageJob",
  Database | DrizzleTransaction
>({
  entity: "imageJob",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select()
      .from(imageProcessingJob)
      .where(and(eq(imageProcessingJob.id, id), notDeleted(imageProcessingJob)))
      .limit(1);
    return row;
  },
  fromDB: async (db, row) =>
    imageJobOut.parse((await hydrateRead(db, [row], { kind: "full" }))[0]),
});

export const imageJobRepository = defineRepository("imageJob", {
  get: (ctx: EntityKernelContext, code: string) =>
    reader.getByShortcode(ctx.db, code),
  list: (
    ctx: EntityKernelContext,
    filters: ImageJobFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
  ) => listImageJobs(ctx.db, filters, sorts, pagination),
  listRead: (
    ctx: EntityKernelContext,
    filters: ImageJobFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection,
  ) => listImageJobsRead(ctx.db, filters, sorts, pagination, projection),
});

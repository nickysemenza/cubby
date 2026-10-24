import {
  ACTIVITY_KIND_LABEL,
  imageProcessingJobKind,
} from "@cubby/schemas/activity";
import {
  type ImageJobFilters,
  type ImageJobOut,
  imageJobOut,
} from "@cubby/schemas/image-job";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import { imageProcessingJob } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  createEntityReader,
  createEntityRowFetcher,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
} from "../image-processing/repo/image-processing";

type ImageJobRow = typeof imageProcessingJob.$inferSelect;

const scaffold = listScaffold("imageJob", imageProcessingJob);

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

const imageJobRead = {
  media: true,
  references: {
    runId: { kind: "lookup", missing: "null", includeDeleted: true },
  },
  bindings: (bind) => {
    const images = bind.batch(({ db, rows }) =>
      lookupEntityReferences(
        db,
        "image",
        rows.map((row) => row.imageId),
        { includeDeleted: true },
      ),
    );
    const facts = bind.batch(({ db, rows }) =>
      loadFacts(
        db,
        rows.map((row) => row.id),
      ),
    );
    return [
      images.fields(
        imageJobOut.pick({ imageId: true, displayName: true }),
        (row, loaded) => {
          const image = loaded.get(row.imageId);
          if (!image) throw new Error("Image job's Image reference is missing");
          return {
            imageId: image.id,
            displayName: `${ACTIVITY_KIND_LABEL[imageProcessingJobKind.parse(row.kind)]} · ${image.name ?? image.id}`,
          };
        },
      ),
      bind(imageJobOut.pick({ durationMs: true }), (row) => ({
        durationMs:
          row.completedAt && row.dispatchedAt
            ? Math.max(
                0,
                row.completedAt.getTime() - row.dispatchedAt.getTime(),
              )
            : null,
      })),
      facts.fields(
        imageJobOut.pick({
          chargedCost: true,
          standardCost: true,
          lastExecutor: true,
          lastError: true,
        }),
        (row, loaded) => {
          const fact = loaded.get(row.id);
          return {
            chargedCost: fact?.chargedCost ?? 0,
            standardCost: fact?.standardCost ?? 0,
            lastExecutor: fact?.lastExecutor ?? null,
            lastError: issueText(row, fact?.deviceRan ?? false),
          };
        },
      ),
    ];
  },
} satisfies ListReadOptions<ImageJobRow>;
const hydrateRead = (
  db: Database | DrizzleTransaction,
  rows: ImageJobRow[],
  projection: ListProjection,
) =>
  listReadPlan<ImageJobRow>("imageJob", imageJobRead).read(
    db,
    rows,
    projection,
  );

export const listImageJobsRead = (
  db: Database,
  filters: ImageJobFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  scaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    {
      read: imageJobRead,
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
  fetchById: createEntityRowFetcher(imageProcessingJob),
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
    readIntent: ListReadIntent = "page",
  ) =>
    listImageJobsRead(
      ctx.db,
      filters,
      sorts,
      pagination,
      projection,
      readIntent,
    ),
});

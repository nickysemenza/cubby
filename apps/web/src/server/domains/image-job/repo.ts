import {
  ACTIVITY_KIND_LABEL,
  imageProcessingJobKind,
} from "@cubby/schemas/activity";
import {
  type ImageJobRawOut as RawImageJobOut,
  imageJobRawOut as rawImageJobOut,
} from "@cubby/schemas/entity-contracts/imageJob";
import {
  deviceShortcode,
  type DeviceShortcode,
} from "@cubby/schemas/identifiers";
import type { ImageProcessingJobState } from "@cubby/schemas/image-processing";
import { describeJobWaitingOn } from "@cubby/schemas/job";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { imageProcessingAttempt } from "~/server/db/image-processing-schema";
import { device, imageProcessingJob } from "~/server/db/schema";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { listReadValue } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import { type ListReadOptions } from "~/server/generic/list/repo/list-projection";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  imageJobDisplayStateSql,
  imageJobWaitingOn,
} from "../image-processing/repo/image-job-state";
import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
} from "../image-processing/repo/image-processing";

type ImageJobRow = typeof imageProcessingJob.$inferSelect;

type Facts = {
  chargedCost: number;
  standardCost: number;
  lastExecutor: string | null;
  deviceRan: boolean;
  state: ImageProcessingJobState;
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
    state: ImageProcessingJobState;
  }>(sql`
    SELECT j.id, cost.charged, cost.standard,
      coalesce(
        (SELECT a.executor->>${"name"} FROM "ImageProcessingAttempt" a
          WHERE a."jobId" = j.id AND a.executor IS NOT NULL
          ORDER BY a.number DESC LIMIT 1),
        CASE WHEN (j.kind = ${imageProcessingJobKind.enum.describe_image} AND j."processorRevision" = ${IMAGE_DESCRIPTION_PROCESSOR_REVISION})
          OR (j.kind = ${imageProcessingJobKind.enum.identify_image} AND j."processorRevision" = ${IMAGE_IDENTIFICATION_PROCESSOR_REVISION})
          THEN 'AI Gateway' END
      ) AS executor,
      EXISTS (SELECT 1 FROM "ImageProcessingAttempt" a
        WHERE a."jobId" = j.id AND a.executor->>${"kind"} = ${"device"}) AS "deviceRan",
      ${imageJobDisplayStateSql("j")} AS state
    FROM "ImageProcessingJob" j
    -- Each usage source probes "AiUsage_job_idx" by its own (jobKind, jobId).
    -- An OR with an attempt-id IN list cannot, and scanned every attempt's
    -- usage once per job and sum (~775 ms for a 50-row page).
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(u."chargedCost"), 0) AS charged,
        coalesce(sum(u."standardCost"), 0) AS standard
      FROM (
        SELECT u."chargedCost", u."standardCost"
          FROM "ImageProcessingAttempt" a
          JOIN "AiUsage" u ON u."jobKind" = ${"image_processing_attempt"}
            AND u."jobId" = a.id::text
          WHERE a."jobId" = j.id AND ${notDeleted("u")}
        UNION ALL
        SELECT u."chargedCost", u."standardCost" FROM "AiUsage" u
          WHERE u."jobKind" = j.kind AND u."jobId" = j.id::text
            AND ${notDeleted("u")}
      ) u
    ) cost
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
        state: row.state,
      },
    ]),
  );
};

type Execution = Pick<
  RawImageJobOut,
  "waitingOn" | "leaseDeviceId" | "leaseExpiresAt"
>;

/**
 * The Device (`DEV-` code) behind each held attempt. The attempt's executor names the
 * install (`executor.deviceId` is `Device.installationId`). Cloud attempts and
 * deleted installs have no Device and stay absent.
 */
const loadLeaseDevices = async (
  db: Database | DrizzleTransaction,
  attemptIds: readonly string[],
): Promise<
  Map<string, { name: string | null; device: DeviceShortcode | null }>
> => {
  if (attemptIds.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({
      token: imageProcessingAttempt.id,
      shortcode: device.shortcode,
      name: sql<string | null>`${imageProcessingAttempt.executor}->>${"name"}`,
    })
    .from(imageProcessingAttempt)
    .leftJoin(
      device,
      and(
        eq(
          device.installationId,
          sql`${imageProcessingAttempt.executor}->>${"deviceId"}`,
        ),
        notDeleted(device),
      ),
    )
    .where(inArray(imageProcessingAttempt.id, [...attemptIds]));
  return new Map(
    rows.map((row) => [
      row.token,
      {
        name: row.name,
        device: row.shortcode ? deviceShortcode.parse(row.shortcode) : null,
      },
    ]),
  );
};

/**
 * An executor's skip reason is stored as a code: on a job that retries it
 * (executor skips are failures now) or on one an older release ended as
 * skipped. The household reads what Apple decided, or that an older policy
 * skipped it. Stored diagnostics stay intact.
 */
const issueText = (row: ImageJobRow, deviceRan: boolean) => {
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
    const execution = bind.batch(async ({ db, rows }) => {
      // `state` arrives as the derived display state (`leased`, `failed`,
      // ...), so only the stored terminal outcomes rule a row out.
      const open = rows.filter(
        (row) => row.state !== "ready" && row.state !== "skipped",
      );
      if (!open.length) return new Map<string, Execution>();
      const now = new Date();
      const holders = await loadLeaseDevices(
        db,
        open.flatMap((row) =>
          row.leaseUntil && row.attemptId ? [row.attemptId] : [],
        ),
      );
      return new Map(
        open.map((row): [string, Execution] => {
          const holder =
            row.leaseUntil && row.attemptId
              ? (holders.get(row.attemptId) ?? null)
              : null;
          return [
            row.id,
            {
              waitingOn: describeJobWaitingOn(
                imageJobWaitingOn(row, now, {
                  name: holder?.name ?? null,
                  deviceId: holder?.device ?? null,
                }),
              ),
              leaseDeviceId: holder?.device ?? null,
              leaseExpiresAt: row.leaseUntil,
            },
          ];
        }),
      );
    });
    return [
      execution.fields(
        rawImageJobOut.pick({
          waitingOn: true,
          leaseDeviceId: true,
          leaseExpiresAt: true,
        }),
        (row, loaded) =>
          loaded.get(row.id) ?? {
            waitingOn: null,
            leaseDeviceId: null,
            leaseExpiresAt: null,
          },
      ),
      images.fields(
        rawImageJobOut.pick({ imageId: true, displayName: true }),
        (row, loaded) => {
          const image = loaded.get(row.imageId);
          if (!image) throw new Error("Image job's Image reference is missing");
          return {
            imageId: image.id,
            displayName: `${ACTIVITY_KIND_LABEL[imageProcessingJobKind.parse(row.kind)]} · ${image.name ?? image.id}`,
          };
        },
      ),
      bind(rawImageJobOut.pick({ durationMs: true }), (row) => ({
        durationMs:
          row.completedAt && row.dispatchedAt
            ? Math.max(
                0,
                row.completedAt.getTime() - row.dispatchedAt.getTime(),
              )
            : null,
      })),
      facts.fields(
        rawImageJobOut.pick({
          chargedCost: true,
          standardCost: true,
          lastExecutor: true,
          lastError: true,
          state: true,
        }),
        (row, loaded) => {
          const fact = loaded.get(row.id);
          return {
            chargedCost: fact?.chargedCost ?? 0,
            standardCost: fact?.standardCost ?? 0,
            lastExecutor: fact?.lastExecutor ?? null,
            lastError: issueText(row, fact?.deviceRan ?? false),
            state: fact?.state ?? row.state,
          };
        },
      ),
    ];
  },
} satisfies ListReadOptions<ImageJobRow>;
const imageJobScaffold = listScaffold("imageJob", imageProcessingJob, {
  // Built per read: the derivation compares lease expiry with the read's time.
  derived: { state: listReadValue(() => imageJobDisplayStateSql()) },
  read: {
    ...imageJobRead,
    title: sql`${imageProcessingJob.kind}`,
  },
});

export const imageJobRepository = defineRepository("imageJob", {
  scaffold: imageJobScaffold,
});

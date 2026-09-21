import type { ImageId } from "@cubby/schemas/identifiers";
import type {
  ImageDerivativePurpose,
  ImageDerivativeStatus,
  ImageProcessingJobKind,
  ImageProcessingJobState,
} from "@cubby/schemas/image-processing";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { image } from "./schema";

const timestamps = () => ({
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
const pkUuid = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const softDeletedAt = () => ({
  deletedAt: timestamp("deletedAt", { mode: "date" }),
});

/**
 * A non-gallery representation produced from an immutable original Image.
 * The source hash/revision gate adoption and make a later source replacement
 * unable to accidentally reuse stale bytes.
 */
export const imageDerivative = pgTable(
  "ImageDerivative",
  {
    id: pkUuid(),
    imageId: uuid("imageId")
      .notNull()
      .$type<ImageId>()
      .references((): AnyPgColumn => image.id),
    purpose: text("purpose").notNull().$type<ImageDerivativePurpose>(),
    status: text("status").notNull().$type<ImageDerivativeStatus>(),
    key: text("key").notNull(),
    sourceContentHash: text("sourceContentHash").notNull(),
    processorRevision: integer("processorRevision").notNull(),
    contentType: text("contentType"),
    sha256: text("sha256"),
    width: integer("width"),
    height: integer("height"),
    failureReason: text("failureReason"),
    ...timestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("ImageDerivative_image_purpose_source_revision_key")
      .on(
        table.imageId,
        table.purpose,
        table.sourceContentHash,
        table.processorRevision,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("ImageDerivative_storage_key_key")
      .on(table.key)
      .where(sql`${table.deletedAt} IS NULL`),
    index("ImageDerivative_image_idx").on(table.imageId),
    index("ImageDerivative_status_idx").on(table.status),
    check(
      "ImageDerivative_purpose_check",
      sql`${table.purpose} IN ('transparent')`,
    ),
    check(
      "ImageDerivative_status_check",
      sql`${table.status} IN ('pending', 'ready', 'skipped', 'failed', 'abandoned')`,
    ),
    check(
      "ImageDerivative_ready_metadata_check",
      sql`${table.status} <> 'ready' OR (${table.contentType} IS NOT NULL AND ${table.contentType} = 'image/png' AND ${table.sha256} IS NOT NULL AND ${table.width} IS NOT NULL AND ${table.width} > 0 AND ${table.height} IS NOT NULL AND ${table.height} > 0)`,
    ),
  ],
);

/** Postgres is authoritative; queue messages are only wakeups for these rows. */
export const imageProcessingJob = pgTable(
  "ImageProcessingJob",
  {
    id: pkUuid(),
    publicId: text("publicId")
      .notNull()
      .default(sql`'IPR-' || upper(replace(gen_random_uuid()::text, '-', ''))`),
    imageId: uuid("imageId")
      .notNull()
      .$type<ImageId>()
      .references((): AnyPgColumn => image.id),
    derivativeId: uuid("derivativeId").references(
      (): AnyPgColumn => imageDerivative.id,
    ),
    kind: text("kind").notNull().$type<ImageProcessingJobKind>(),
    state: text("state").notNull().$type<ImageProcessingJobState>(),
    sourceContentHash: text("sourceContentHash").notNull(),
    processorRevision: integer("processorRevision").notNull(),
    submissionId: uuid("submissionId").references(
      (): AnyPgColumn => imageProcessingSubmission.id,
      { onDelete: "set null" },
    ),
    attemptId: uuid("attemptId"),
    leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date" }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("nextAttemptAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    dispatchedAt: timestamp("dispatchedAt", { mode: "date" }),
    completedAt: timestamp("completedAt", { mode: "date" }),
    lastError: text("lastError"),
    runtime: jsonb("runtime").$type<unknown>(),
    result: jsonb("result").$type<unknown>(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ImageProcessingJob_publicId_key").on(table.publicId),
    uniqueIndex("ImageProcessingJob_identity_key").on(
      table.imageId,
      table.kind,
      table.sourceContentHash,
      table.processorRevision,
    ),
    index("ImageProcessingJob_dispatch_idx").on(
      table.state,
      table.nextAttemptAt,
    ),
    index("ImageProcessingJob_image_idx").on(table.imageId),
    check(
      "ImageProcessingJob_kind_check",
      sql`${table.kind} IN ('subject_lift', 'describe_image')`,
    ),
    check(
      "ImageProcessingJob_state_check",
      sql`${table.state} IN ('pending', 'waiting_for_device', 'leased', 'ready', 'skipped', 'failed')`,
    ),
    check("ImageProcessingJob_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "ImageProcessingJob_lease_check",
      sql`(${table.state} = 'leased') = (${table.attemptId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

/** User-confirmed text remains separate from model output and backfills. */
export const imageDescriptionCorrection = pgTable(
  "ImageDescriptionCorrection",
  {
    id: pkUuid(),
    imageId: uuid("imageId")
      .notNull()
      .$type<ImageId>()
      .references((): AnyPgColumn => image.id),
    description: text("description").notNull(),
    confirmedAt: timestamp("confirmedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    ...softDeletedAt(),
  },
  (table) => [
    index("ImageDescriptionCorrection_image_idx").on(table.imageId),
    uniqueIndex("ImageDescriptionCorrection_active_image_key")
      .on(table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

/**
 * A deleted derivative's server-chosen key remains here until storage cleanup
 * observes it. A companion that PUTs after deletion therefore leaves a known,
 * reclaimable orphan instead of an untraceable object in R2.
 */
export const imageProcessingOrphan = pgTable(
  "ImageProcessingOrphan",
  {
    id: pkUuid(),
    key: text("key").notNull(),
    attemptId: uuid("attemptId"),
    reason: text("reason").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ImageProcessingOrphan_key_key").on(table.key),
    index("ImageProcessingOrphan_createdAt_idx").on(table.createdAt),
  ],
);

/** A lease is archived independently of the mutable dispatch row. */
export const imageProcessingAttempt = pgTable(
  "ImageProcessingAttempt",
  {
    id: uuid("id").primaryKey(),
    jobId: uuid("jobId")
      .notNull()
      .references((): AnyPgColumn => imageProcessingJob.id, {
        onDelete: "cascade",
      }),
    number: integer("number").notNull(),
    submissionId: uuid("submissionId").references(
      (): AnyPgColumn => imageProcessingSubmission.id,
      { onDelete: "set null" },
    ),
    inputKey: text("inputKey"),
    state: text("state").notNull(),
    executor:
      jsonb("executor").$type<
        import("@cubby/schemas/activity").ActivityExecutor
      >(),
    assignedUserId: text("assignedUserId"),
    assignedConnectionId: text("assignedConnectionId"),
    diagnostics: jsonb("diagnostics").$type<unknown>(),
    result: jsonb("result").$type<unknown>(),
    error: text("error"),
    startedAt: timestamp("startedAt", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("ImageProcessingAttempt_job_number_key").on(
      table.jobId,
      table.number,
    ),
    index("ImageProcessingAttempt_device_idx").on(
      sql`(${table.executor}->>'deviceId')`,
    ),
    index("ImageProcessingAttempt_submission_idx").on(table.submissionId),
    check("ImageProcessingAttempt_number_check", sql`${table.number} > 0`),
    check(
      "ImageProcessingAttempt_state_check",
      sql`${table.state} IN ('leased','running','waiting','expired','ready','skipped','failed')`,
    ),
  ],
);

export const imageProcessingEvent = pgTable(
  "ImageProcessingEvent",
  {
    id: pkUuid(),
    jobId: uuid("jobId")
      .notNull()
      .references((): AnyPgColumn => imageProcessingJob.id, {
        onDelete: "cascade",
      }),
    eventKey: text("eventKey").notNull(),
    attempt: integer("attempt"),
    event: text("event").notNull(),
    level: text("level").notNull().default("info"),
    source: text("source").notNull().default("server"),
    details: jsonb("details").$type<unknown>(),
    occurredAt: timestamp("occurredAt", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ImageProcessingEvent_job_event_key").on(
      table.jobId,
      table.eventKey,
    ),
    index("ImageProcessingEvent_job_time_idx").on(
      table.jobId,
      table.occurredAt,
      table.id,
    ),
  ],
);

export const imageProcessingSubmission = pgTable(
  "ImageProcessingSubmission",
  {
    id: pkUuid(),
    publicId: text("publicId")
      .notNull()
      .default(sql`'IPS-' || upper(replace(gen_random_uuid()::text, '-', ''))`),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ImageProcessingSubmission_publicId_key").on(table.publicId),
  ],
);

export const imageProcessingSubmissionJob = pgTable(
  "ImageProcessingSubmissionJob",
  {
    id: pkUuid(),
    submissionId: uuid("submissionId")
      .notNull()
      .references((): AnyPgColumn => imageProcessingSubmission.id, {
        onDelete: "cascade",
      }),
    jobId: uuid("jobId")
      .notNull()
      .references((): AnyPgColumn => imageProcessingJob.id, {
        onDelete: "cascade",
      }),
    disposition: text("disposition").notNull(),
    baselineAttempts: integer("baselineAttempts").notNull(),
  },
  (table) => [
    uniqueIndex("ImageProcessingSubmissionJob_membership_key").on(
      table.submissionId,
      table.jobId,
    ),
    check(
      "ImageProcessingSubmissionJob_disposition_check",
      sql`${table.disposition} IN ('new','reused','running','retry')`,
    ),
    check(
      "ImageProcessingSubmissionJob_baseline_check",
      sql`${table.baselineAttempts} >= 0`,
    ),
  ],
);

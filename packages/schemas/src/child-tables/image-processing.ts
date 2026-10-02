import { defineChildTable } from "../entity-definitions/child-definition.js";

export const imageProcessingChildren = [
  /**
   * A non-gallery representation produced from an immutable original Image.
   * The source hash/revision gate adoption and make a later source replacement
   * unable to accidentally reuse stale bytes.
   */
  defineChildTable({
    name: "ImageDerivative",
    exportName: "imageDerivative",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "imageId",
        kind: "uuid",
        notNull: true,
        type: "ImageId",
        reference: { table: "image", column: "id" },
      },
      {
        key: "purpose",
        kind: "text",
        notNull: true,
        type: "ImageDerivativePurpose",
      },
      {
        key: "status",
        kind: "text",
        notNull: true,
        type: "ImageDerivativeStatus",
      },
      { key: "key", kind: "text", notNull: true },
      { key: "sourceContentHash", kind: "text", notNull: true },
      { key: "processorRevision", kind: "integer", notNull: true },
      { key: "contentType", kind: "text" },
      { key: "sha256", kind: "text" },
      { key: "width", kind: "integer" },
      { key: "height", kind: "integer" },
      { key: "failureReason", kind: "text" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
      { key: "deletedAt", kind: "timestamp" },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["ImageId"] },
      {
        module: "@cubby/schemas/image-processing",
        exports: ["ImageDerivativePurpose", "ImageDerivativeStatus"],
      },
    ],
    indexes: [
      {
        name: "ImageDerivative_image_purpose_source_revision_key",
        unique: true,
        on: ["imageId", "purpose", "sourceContentHash", "processorRevision"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "ImageDerivative_storage_key_key",
        unique: true,
        on: ["key"],
        where: "{deletedAt} IS NULL",
      },
      { name: "ImageDerivative_image_idx", on: ["imageId"] },
      { name: "ImageDerivative_status_idx", on: ["status"] },
    ],
    checks: [
      {
        name: "ImageDerivative_purpose_check",
        sql: "{purpose} IN ('transparent')",
      },
      {
        name: "ImageDerivative_status_check",
        sql: "{status} IN ('pending', 'ready', 'skipped', 'failed', 'abandoned')",
      },
      {
        name: "ImageDerivative_ready_metadata_check",
        sql: "{status} <> 'ready' OR ({contentType} IS NOT NULL AND {contentType} = 'image/png' AND {sha256} IS NOT NULL AND {width} IS NOT NULL AND {width} > 0 AND {height} IS NOT NULL AND {height} > 0)",
      },
    ],
  }),
  /** Postgres is authoritative; queue messages are only wakeups for these rows. */
  defineChildTable({
    name: "ImageProcessingJob",
    exportName: "imageProcessingJob",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "publicId",
        kind: "text",
        notNull: true,
        default: {
          sql: "'IPR-' || upper(replace(gen_random_uuid()::text, '-', ''))",
        },
      },
      {
        key: "imageId",
        kind: "uuid",
        notNull: true,
        type: "ImageId",
        reference: { table: "image", column: "id" },
      },
      {
        key: "derivativeId",
        kind: "uuid",
        reference: { table: "imageDerivative", column: "id" },
      },
      {
        key: "kind",
        kind: "text",
        notNull: true,
        type: "ImageProcessingJobKind",
      },
      {
        key: "state",
        kind: "text",
        notNull: true,
        type: "ImageProcessingJobState",
      },
      { key: "sourceContentHash", kind: "text", notNull: true },
      { key: "processorRevision", kind: "integer", notNull: true },
      {
        key: "submissionId",
        kind: "uuid",
        reference: {
          table: "imageProcessingSubmission",
          column: "id",
          onDelete: "set null",
        },
      },
      // The Run that requested this job, when one exists (a request actor's
      // photo run, or an inherited run); background maintenance leaves it
      // null and the dispatcher falls back to `systemActor()`.
      {
        // The requesting Run is absent for background maintenance, which uses systemActor().
        key: "runId",
        kind: "uuid",
        type: "RunId",
        reference: { table: "run", column: "id", onDelete: "set null" },
      },
      { key: "attemptId", kind: "uuid" },
      { key: "leaseExpiresAt", kind: "timestamp" },
      { key: "attempts", kind: "integer", notNull: true, default: 0 },
      {
        key: "nextAttemptAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      { key: "dispatchedAt", kind: "timestamp" },
      { key: "completedAt", kind: "timestamp" },
      { key: "lastError", kind: "text" },
      { key: "runtime", kind: "jsonb", type: "unknown" },
      { key: "result", kind: "jsonb", type: "unknown" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["ImageId", "RunId"] },
      {
        module: "@cubby/schemas/image-processing",
        exports: ["ImageProcessingJobKind", "ImageProcessingJobState"],
      },
    ],
    indexes: [
      {
        name: "ImageProcessingJob_publicId_key",
        unique: true,
        on: ["publicId"],
      },
      {
        name: "ImageProcessingJob_identity_key",
        unique: true,
        on: ["imageId", "kind", "sourceContentHash", "processorRevision"],
      },
      {
        name: "ImageProcessingJob_dispatch_idx",
        on: ["state", "nextAttemptAt"],
      },
      {
        name: "ImageProcessingJob_runId_idx",
        on: ["runId"],
        where: "{runId} IS NOT NULL",
      },
    ],
    checks: [
      {
        name: "ImageProcessingJob_kind_check",
        sql: "{kind} IN ('subject_lift', 'describe_image')",
      },
      {
        name: "ImageProcessingJob_state_check",
        sql: "{state} IN ('pending', 'waiting_for_device', 'leased', 'ready', 'skipped', 'failed')",
      },
      { name: "ImageProcessingJob_attempts_check", sql: "{attempts} >= 0" },
      {
        name: "ImageProcessingJob_lease_check",
        sql: "({state} = 'leased') = ({attemptId} IS NOT NULL AND {leaseExpiresAt} IS NOT NULL)",
      },
    ],
  }),
  /** User-confirmed text remains separate from model output and backfills. */
  defineChildTable({
    name: "ImageDescriptionCorrection",
    exportName: "imageDescriptionCorrection",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "imageId",
        kind: "uuid",
        notNull: true,
        type: "ImageId",
        reference: { table: "image", column: "id" },
      },
      { key: "description", kind: "text", notNull: true },
      {
        key: "confirmedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      { key: "deletedAt", kind: "timestamp" },
    ],
    types: [{ module: "@cubby/schemas/identifiers", exports: ["ImageId"] }],
    indexes: [
      { name: "ImageDescriptionCorrection_image_idx", on: ["imageId"] },
      {
        name: "ImageDescriptionCorrection_active_image_key",
        unique: true,
        on: ["imageId"],
        where: "{deletedAt} IS NULL",
      },
    ],
  }),
  /**
   * A deleted derivative's server-chosen key remains here until storage cleanup
   * observes it. A companion that PUTs after deletion therefore leaves a known,
   * reclaimable orphan instead of an untraceable object in R2.
   */
  defineChildTable({
    name: "ImageProcessingOrphan",
    exportName: "imageProcessingOrphan",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "key", kind: "text", notNull: true },
      { key: "attemptId", kind: "uuid" },
      { key: "reason", kind: "text", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [
      { name: "ImageProcessingOrphan_key_key", unique: true, on: ["key"] },
      { name: "ImageProcessingOrphan_createdAt_idx", on: ["createdAt"] },
    ],
  }),
  /** A lease is archived independently of the mutable dispatch row. */
  defineChildTable({
    name: "ImageProcessingAttempt",
    exportName: "imageProcessingAttempt",
    columns: [
      { key: "id", kind: "uuid", primaryKey: true },
      {
        key: "jobId",
        kind: "uuid",
        notNull: true,
        reference: {
          table: "imageProcessingJob",
          column: "id",
          onDelete: "cascade",
        },
      },
      { key: "number", kind: "integer", notNull: true },
      {
        key: "submissionId",
        kind: "uuid",
        reference: {
          table: "imageProcessingSubmission",
          column: "id",
          onDelete: "set null",
        },
      },
      { key: "inputKey", kind: "text" },
      { key: "state", kind: "text", notNull: true },
      { key: "executor", kind: "jsonb", type: "ActivityExecutor" },
      { key: "assignedUserId", kind: "text" },
      { key: "assignedConnectionId", kind: "text" },
      { key: "diagnostics", kind: "jsonb", type: "unknown" },
      { key: "result", kind: "jsonb", type: "unknown" },
      { key: "error", kind: "text" },
      {
        key: "startedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      { key: "completedAt", kind: "timestamp" },
    ],
    types: [
      { module: "@cubby/schemas/activity", exports: ["ActivityExecutor"] },
    ],
    indexes: [
      {
        name: "ImageProcessingAttempt_job_number_key",
        unique: true,
        on: ["jobId", "number"],
      },
      {
        name: "ImageProcessingAttempt_device_idx",
        on: [{ sql: "({executor}->>'deviceId')" }],
      },
      { name: "ImageProcessingAttempt_submission_idx", on: ["submissionId"] },
    ],
    checks: [
      { name: "ImageProcessingAttempt_number_check", sql: "{number} > 0" },
      {
        name: "ImageProcessingAttempt_state_check",
        sql: "{state} IN ('leased','running','waiting','expired','ready','skipped','failed')",
      },
    ],
  }),
  defineChildTable({
    name: "ImageProcessingEvent",
    exportName: "imageProcessingEvent",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "jobId",
        kind: "uuid",
        notNull: true,
        reference: {
          table: "imageProcessingJob",
          column: "id",
          onDelete: "cascade",
        },
      },
      { key: "eventKey", kind: "text", notNull: true },
      { key: "attempt", kind: "integer" },
      { key: "event", kind: "text", notNull: true },
      { key: "level", kind: "text", notNull: true, default: "info" },
      { key: "source", kind: "text", notNull: true, default: "server" },
      { key: "details", kind: "jsonb", type: "unknown" },
      {
        key: "occurredAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [
      {
        name: "ImageProcessingEvent_job_event_key",
        unique: true,
        on: ["jobId", "eventKey"],
      },
      {
        name: "ImageProcessingEvent_job_time_idx",
        on: ["jobId", "occurredAt", "id"],
      },
    ],
  }),
  defineChildTable({
    name: "ImageProcessingSubmission",
    exportName: "imageProcessingSubmission",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "publicId",
        kind: "text",
        notNull: true,
        default: {
          sql: "'IPS-' || upper(replace(gen_random_uuid()::text, '-', ''))",
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [
      {
        name: "ImageProcessingSubmission_publicId_key",
        unique: true,
        on: ["publicId"],
      },
    ],
  }),
  defineChildTable({
    name: "ImageProcessingSubmissionJob",
    exportName: "imageProcessingSubmissionJob",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "submissionId",
        kind: "uuid",
        notNull: true,
        reference: {
          table: "imageProcessingSubmission",
          column: "id",
          onDelete: "cascade",
        },
      },
      {
        key: "jobId",
        kind: "uuid",
        notNull: true,
        reference: {
          table: "imageProcessingJob",
          column: "id",
          onDelete: "cascade",
        },
      },
      { key: "disposition", kind: "text", notNull: true },
      { key: "baselineAttempts", kind: "integer", notNull: true },
    ],
    indexes: [
      {
        name: "ImageProcessingSubmissionJob_membership_key",
        unique: true,
        on: ["submissionId", "jobId"],
      },
    ],
    checks: [
      {
        name: "ImageProcessingSubmissionJob_disposition_check",
        sql: "{disposition} IN ('new','reused','running','retry')",
      },
      {
        name: "ImageProcessingSubmissionJob_baseline_check",
        sql: "{baselineAttempts} >= 0",
      },
    ],
  }),
];

import { z } from "zod";

import {
  ACTIVITY_KIND_LABEL,
  imageProcessingJobKind,
  imageProcessingJobState,
} from "../activity-fields.js";
import {
  imageShortcode,
  runShortcode,
  shortcodeSchema,
} from "../identifier-fields.js";
import { defineEntity } from "./definition.js";

const readOnly = <T extends z.ZodTypeAny>(read: T) => ({
  read,
  create: null,
  update: null,
});

const kindOptions = imageProcessingJobKind.options.map((value) => ({
  value,
  label: ACTIVITY_KIND_LABEL[value],
}));

const stateOptions: {
  value: (typeof imageProcessingJobState.options)[number];
  label: string;
  color: string;
}[] = [
  { value: "pending", label: "Queued", color: "var(--muted-foreground)" },
  {
    value: "waiting_for_device",
    label: "Waiting for Apple",
    color: "var(--warning)",
  },
  { value: "leased", label: "Processing", color: "var(--primary)" },
  { value: "ready", label: "Completed", color: "var(--positive)" },
  { value: "skipped", label: "Skipped", color: "var(--muted-foreground)" },
  { value: "failed", label: "Failed", color: "var(--destructive)" },
];

/**
 * One durable unit of image work (subject lift, description, identification)
 * for one Image source and processor revision. Postgres is authoritative; the
 * Worker queue and the Apple companion only claim and complete these rows, so
 * every client reads them through the generic list and detail.
 */
export default defineEntity({
  key: "imageJob",
  names: { singular: "Image job", plural: "Image jobs" },
  route: { basePath: "image-jobs" },
  // The table keeps its storage name; the job's UUID is the queue and lease identity.
  table: "ImageProcessingJob",
  identifiers: { brand: "ImageJobId", shortcode: "IPR-" },
  presentation: {
    titleField: "displayName",
    domain: null,
    description:
      "Image processing work: subject lifts, descriptions and identifications, with every attempt.",
    emptyState: {
      title: "No image jobs yet",
      description:
        "Uploading an image schedules its subject lift, description and identification.",
    },
    icons: {
      phosphor: "ImageSquare",
      sfSymbol: "photo.badge.checkmark",
      emoji: "🖼️",
    },
    detail: {
      hero: { chip: "state", stats: [] },
      additionalSections: [
        { kind: "slot", id: "attempts", title: "Attempts and events" },
      ],
    },
    list: {
      savedViews: [
        {
          id: "attention",
          label: "Needs attention",
          description: "Image jobs waiting for an Apple device or failed",
          filters: [{ id: "state", value: ["waiting_for_device", "failed"] }],
        },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "id",
        kind: "identifier",
        validation: readOnly(shortcodeSchema("imageJob")),
      },
      {
        key: "displayName",
        kind: "text",
        provenance: {
          kind: "derived",
          sources: [{ label: "Kind" }, { label: "Image" }],
        },
        explanation: {
          ruleId: "image-job.display-name",
          description: "The kind of work and the Image it processes.",
        },
        validation: readOnly(z.string().min(1)),
      },
      {
        key: "kind",
        kind: "enum",
        control: { kind: "select", options: kindOptions },
        display: { list: true, detail: true },
        validation: readOnly(imageProcessingJobKind),
      },
      {
        key: "state",
        kind: "enum",
        control: { kind: "select", options: stateOptions },
        display: { list: true, detail: true, width: "sm" },
        validation: readOnly(imageProcessingJobState),
      },
      {
        key: "imageId",
        kind: "identifier",
        reference: { entity: "image" },
        display: { list: true, detail: true },
        validation: readOnly(imageShortcode),
      },
      {
        key: "runId",
        kind: "identifier",
        nullable: true,
        // Background maintenance schedules jobs without a requesting Run.
        reference: { entity: "run" },
        display: { list: true, detail: true },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "attempts",
        kind: "number",
        display: { list: true, detail: true },
        validation: readOnly(z.int().nonnegative()),
      },
      {
        key: "lastExecutor",
        kind: "text",
        nullable: true,
        display: { columnLabel: "Executor", list: true, detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "Latest attempt" }],
        },
        explanation: {
          ruleId: "image-job.last-executor",
          description:
            "Where the latest attempt ran: AI Gateway or the Apple device that claimed it.",
        },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "lastError",
        kind: "text",
        nullable: true,
        display: { columnLabel: "Last error", list: true, detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "durationMs",
        kind: "number",
        nullable: true,
        display: { columnLabel: "Duration (ms)", detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "Dispatch and completion times" }],
        },
        explanation: {
          ruleId: "image-job.duration",
          description: "Milliseconds from dispatch to completion.",
        },
        validation: readOnly(z.number().nonnegative().nullable()),
      },
      {
        key: "chargedCost",
        kind: "number",
        display: {
          columnLabel: "Charged",
          list: true,
          detail: true,
          format: "currency",
        },
        provenance: {
          kind: "derived",
          sources: [{ label: "AI usage of this job's attempts" }],
        },
        explanation: {
          ruleId: "image-job.charged-cost",
          description:
            "AI Gateway charges recorded for this job; a linked Run's total may already include them.",
        },
        validation: readOnly(z.number()),
      },
      {
        key: "standardCost",
        kind: "number",
        display: { columnLabel: "Standard", detail: true, format: "currency" },
        provenance: {
          kind: "derived",
          sources: [{ label: "AI usage of this job's attempts" }],
        },
        explanation: {
          ruleId: "image-job.standard-cost",
          description: "The list price of the same AI calls.",
        },
        validation: readOnly(z.number()),
      },
      {
        key: "processorRevision",
        kind: "number",
        display: { detail: true },
        validation: readOnly(z.int()),
      },
      {
        key: "dispatchedAt",
        kind: "timestamp",
        nullable: true,
        display: { detail: true, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "completedAt",
        kind: "timestamp",
        nullable: true,
        display: { list: true, detail: true, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { list: true, detail: true, format: "timestamp" },
        validation: readOnly(z.date()),
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: readOnly(z.date()),
      },
      {
        // Dispatch backoff: the queue claims a job only once this has passed.
        key: "nextAttemptAt",
        kind: "timestamp",
        validation: readOnly(z.date()),
      },
      { key: "shortcode", kind: "text" },
      { key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      { key: "id", specialized: "primary-key:ImageJobId" },
      { key: "shortcode", specialized: "shortcode" },
      { key: "imageId", reference: "image" },
      { key: "kind", specialized: "enum:kind" },
      { key: "state", specialized: "enum:state" },
      { key: "runId", reference: "run" },
      { key: "attempts", defaultValue: 0 },
      "lastError",
      "processorRevision",
      "dispatchedAt",
      "completedAt",
      { key: "nextAttemptAt", defaultOverride: "now" },
      "createdAt",
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [],
    update: [],
    bulk: [],
    audit: [],
    output: [
      "id",
      "displayName",
      "kind",
      "state",
      "imageId",
      "runId",
      "attempts",
      "lastExecutor",
      "lastError",
      "durationMs",
      "chargedCost",
      "standardCost",
      "processorRevision",
      "dispatchedAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ],
    sort: { fields: ["createdAt", "completedAt", "state", "kind"] },
  },
  fields: {
    create: null,
    update: null,
    output: { module: "@cubby/schemas/image-job", export: "imageJobOut" },
  },
  storage: {
    // Queue, lease and adoption state stays operational, outside the model.
    columns: [
      {
        key: "derivativeId",
        kind: "identifier",
        reference: "imageDerivative",
      },
      { key: "sourceContentHash", kind: "text", notNull: true },
      // The first submission; retries join later ones through ImageProcessingSubmissionJob.
      {
        key: "submissionId",
        kind: "identifier",
        reference: "imageProcessingSubmission",
      },
      { key: "attemptId", kind: "identifier" },
      { key: "leaseExpiresAt", kind: "timestamp" },
      { key: "runtime", kind: "json" },
      { key: "result", kind: "json" },
    ],
    indexes: [
      {
        name: "ImageProcessingJob_identity_key",
        unique: true,
        on: ["imageId", "kind", "sourceContentHash", "processorRevision"],
      },
      {
        name: "ImageProcessingJob_dispatch_idx",
        on: ["state", "nextAttemptAt"],
      },
      { on: ["imageId", { column: "createdAt", desc: true }] },
    ],
    checks: [
      { name: "ImageProcessingJob_kind_check", column: "kind", bare: true },
      { name: "ImageProcessingJob_state_check", column: "state", bare: true },
      { name: "ImageProcessingJob_attempts_check", sql: "{attempts} >= 0" },
      {
        name: "ImageProcessingJob_lease_check",
        sql: "({state} = 'leased') = ({attemptId} IS NOT NULL AND {leaseExpiresAt} IS NOT NULL)",
      },
    ],
  },
  filters: {
    schema: {
      module: "@cubby/schemas/image-job",
      export: "imageJobFilterFields",
    },
    descriptors: [
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
        stored: true,
        options: kindOptions,
      },
      {
        columnId: "state",
        kind: "multiselect",
        placeholder: "Filter by state...",
        deriveSchema: true,
        stored: true,
        options: stateOptions,
      },
      {
        columnId: "imageId",
        kind: "idMulti",
        placeholder: "Filter by Image...",
        brandRef: { entity: "image" },
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "runId",
        kind: "idMulti",
        placeholder: "Filter by Run...",
        brandRef: { entity: "run" },
        deriveSchema: true,
        stored: true,
      },
      {
        // A job joins every submission that scheduled or retried it
        // (`ImageProcessingSubmissionJob`), so this is membership, not a column.
        columnId: "submissionId",
        kind: "text",
        placeholder: "Filter by submission...",
        urlOnly: true,
      },
      {
        columnId: "createdAt",
        kind: "range",
        placeholder: "Filter by created date...",
        deriveSchema: true,
      },
    ],
  },
  relations: [
    {
      key: "image",
      label: "Image",
      target: "image",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "ImageProcessingJob.imageId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "ImageProcessingJob.imageId", direction: "incoming" }],
      },
    },
    {
      key: "run",
      label: "Requesting Run",
      target: "run",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "ImageProcessingJob.runId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "ImageProcessingJob.runId", direction: "incoming" }],
      },
    },
  ],
  search: false,
  capabilities: {
    auditable: false,
    images: { storage: false },
    softDelete: false,
    delete: null,
    bulkUpdate: null,
    merge: false,
    lifecycle: "readOnly",
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/image-job",
        export: "imageJobRepository",
      },
    },
  },
});

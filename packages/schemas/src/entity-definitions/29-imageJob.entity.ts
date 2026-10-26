import type { EnumIcon } from "@cubby/shared/enum-palette";
import { z } from "zod";
import {
  ACTIVITY_KIND_LABEL,
  imageProcessingJobKind,
  imageProcessingJobState,
} from "../activity-fields.js";
import {
  deviceShortcode,
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

const KIND_GLYPH = {
  subject_lift: { phosphor: "Scissors", sfSymbol: "scissors" },
  describe_image: { phosphor: "TextAa", sfSymbol: "text.below.photo" },
  identify_image: { phosphor: "Scan", sfSymbol: "viewfinder" },
} satisfies Record<z.infer<typeof imageProcessingJobKind>, EnumIcon>;
const kindOptions = imageProcessingJobKind.options.map((value) => ({
  value,
  label: ACTIVITY_KIND_LABEL[value],
  glyph: KIND_GLYPH[value],
}));

const stateOptions = [
  {
    value: "pending",
    label: "Queued",
    color: "neutral-status",
  },
  {
    value: "waiting_for_device",
    label: "Waiting for Apple",
    color: "warning",
  },
  {
    value: "leased",
    label: "Processing",
    color: "info",
  },
  {
    value: "ready",
    label: "Completed",
    color: "positive",
  },
  {
    value: "skipped",
    label: "Skipped",
    color: "neutral-status",
  },
  {
    // Image work never ends as failed: after repeated failures it keeps
    // retrying with backoff and asks for attention.
    value: "failed",
    label: "Needs attention (retrying)",
    color: "destructive",
  },
] satisfies {
  value: string;
  label: string;
  color?: import("@cubby/shared/enum-palette").ColorToken;
  glyph?: import("@cubby/shared/enum-palette").EnumIcon;
}[];

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
      summary: [
        {
          kind: "fields",
          id: "state-reason",
          title: "State & reason",
          fields: ["state", "waitingOn", "lastError"],
        },
        {
          kind: "records",
          id: "image",
          title: "Image",
          viewKey: "relation:image",
        },
        {
          kind: "records",
          id: "requesting-run",
          title: "Requesting Run",
          viewKey: "relation:run",
        },
        {
          kind: "fields",
          id: "attempts-duration",
          title: "Attempts & duration",
          fields: ["attempts", "durationMs"],
        },
        {
          kind: "fields",
          id: "latest-executor",
          title: "Latest executor",
          fields: ["lastExecutor", "completedAt"],
        },
      ],

      hero: {
        chip: "state",
      },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: [
            "kind",
            "state",
            "imageId",
            "runId",
            "attempts",
            "lastExecutor",
            "lastError",
            "waitingOn",
            "leaseDeviceId",
            "leaseExpiresAt",
            "durationMs",
            "chargedCost",
            "standardCost",
            "processorRevision",
            "dispatchedAt",
            "completedAt",
            "createdAt",
            "updatedAt",
          ],
        },
        { kind: "slot", id: "attempts", title: "Attempts and events" },
      ],
    },
    list: {
      // The thumbnail borrows the Image the job processes; quality is the job's own checks.

      savedViews: [
        {
          id: "attention",
          label: "Needs attention",
          description:
            "Image jobs that keep failing; they retry with backoff until they succeed",
          filters: [{ id: "state", value: ["failed"] }],
        },
        {
          id: "waiting-for-apple",
          label: "Waiting for Apple",
          description: "Image jobs parked until an Apple device pulls them",
          filters: [{ id: "state", value: ["waiting_for_device"] }],
          // Parked work has no lease, executor, error or completion yet.
          layout: {
            columnVisibility: {
              leaseDeviceId: false,
              leaseExpiresAt: false,
              lastExecutor: false,
              lastError: false,
              completedAt: false,
            },
          },
        },
        {
          id: "processing",
          label: "Processing",
          description:
            "Image jobs an attempt holds a live lease on, with the device and when the lease lapses",
          filters: [{ id: "state", value: ["leased"] }],
          layout: { columnVisibility: { completedAt: false } },
        },
      ],
    },
  },
  model: {
    fields: [
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: readOnly(shortcodeSchema("imageJob")),
      },
      {
        display: { detail: false, list: false },
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
        display: {
          columnGroup: "Execution",
          optionRole: "category",
          optionColor: "neutral-status",
        },
        validation: readOnly(imageProcessingJobKind),
      },
      {
        key: "state",
        kind: "enum",
        control: { kind: "select", options: stateOptions },
        display: {
          columnGroup: "Execution",
          width: "sm",
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(imageProcessingJobState),
      },
      {
        key: "imageId",
        kind: "identifier",
        reference: { entity: "image" },
        display: { columnGroup: "Scope" },
        validation: readOnly(imageShortcode),
      },
      {
        key: "runId",
        kind: "identifier",
        nullable: true,
        // Background maintenance schedules jobs without a requesting Run.
        reference: { entity: "run" },
        display: { columnGroup: "Scope" },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "attempts",
        kind: "number",
        display: { columnGroup: "Execution" },
        validation: readOnly(z.int().nonnegative()),
      },
      {
        key: "lastExecutor",
        kind: "text",
        nullable: true,
        display: { columnGroup: "Execution", columnLabel: "Executor" },
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
        display: { columnGroup: "Execution", columnLabel: "Last error" },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "waitingOn",
        kind: "text",
        nullable: true,
        display: { columnGroup: "Execution" },
        provenance: {
          kind: "derived",
          sources: [{ label: "The job's execution Job" }],
        },
        explanation: {
          ruleId: "image-job.waiting-on",
          description:
            "What the open job waits on now: a due slot, any Apple device, AI funding, a backoff, or the device holding its lease (an expired lease says so). Empty once the job settles.",
        },
        validation: readOnly(z.string().nullable().default(null)),
      },
      {
        key: "leaseDeviceId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "device" },
        display: { columnGroup: "Execution", columnLabel: "Device" },
        explanation: {
          ruleId: "image-job.lease-device",
          description:
            "The Apple device whose attempt holds the job's lease now, live or expired. Empty when no device holds it.",
        },
        validation: readOnly(deviceShortcode.nullable().default(null)),
      },
      {
        key: "leaseExpiresAt",
        kind: "timestamp",
        nullable: true,
        display: {
          columnGroup: "Execution",
          columnLabel: "Lease ends",
          format: "timestamp",
        },
        provenance: {
          kind: "derived",
          sources: [{ label: "The job's execution Job" }],
        },
        explanation: {
          ruleId: "image-job.lease-expires-at",
          description:
            "When the running attempt's lease lapses unless its device renews it (every 15 s). Past it, any device may reclaim the job.",
        },
        validation: readOnly(z.date().nullable().default(null)),
      },
      {
        key: "durationMs",
        kind: "number",
        nullable: true,
        display: { list: false, columnLabel: "Duration (ms)" },
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
          columnGroup: "Cost",
          columnBar: true,
          columnLabel: "Charged",
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
        display: { list: false, columnLabel: "Standard", format: "currency" },
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
        display: { list: false },
        validation: readOnly(z.int()),
      },
      {
        key: "dispatchedAt",
        kind: "timestamp",
        nullable: true,
        display: { list: false, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "completedAt",
        kind: "timestamp",
        nullable: true,
        display: { columnGroup: "Execution", format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { format: "timestamp" },
        validation: readOnly(z.date()),
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { list: false },
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
      "createdAt",
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [],
    update: [],
    audit: [],
    output: [
      "id",
      "displayName",
      "kind",
      "state",
      "waitingOn",
      "leaseDeviceId",
      "leaseExpiresAt",
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
    rows: {
      submissions: {
        label: "Submissions",
        path: [
          { edge: "ImageProcessingSubmissionJob.jobId", direction: "incoming" },
          {
            edge: "ImageProcessingSubmissionJob.submissionId",
            direction: "outgoing",
          },
        ],
      },
    },
    derived: {
      // Every submission that scheduled or retried the job, not only its first.
      submissionId: { via: "submissions.publicId" },
      // Displayed state derives from the universal Job that owns execution;
      // the stored column keeps only the outcome (docs/jobs.md#image-processing).
      state: {
        type: "enum",
        options: [...imageProcessingJobState.options],
      },
    },
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
      { key: "runtime", kind: "json" },
      { key: "result", kind: "json" },
    ],
    indexes: [
      {
        name: "ImageProcessingJob_identity_key",
        unique: true,
        on: ["imageId", "kind", "sourceContentHash", "processorRevision"],
      },
      { on: ["imageId", { column: "createdAt", desc: true }] },
    ],
    checks: [
      { name: "ImageProcessingJob_kind_check", column: "kind", bare: true },
      { name: "ImageProcessingJob_state_check", column: "state", bare: true },
      { name: "ImageProcessingJob_attempts_check", sql: "{attempts} >= 0" },
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
        options: kindOptions,
      },
      {
        columnId: "state",
        kind: "multiselect",
        placeholder: "Filter by state...",
        deriveSchema: true,
        derived: true,
        options: stateOptions,
      },
      {
        columnId: "imageId",
        kind: "idMulti",
        placeholder: "Filter by Image...",
        brandRef: { entity: "image" },
        deriveSchema: true,
      },
      {
        columnId: "runId",
        kind: "idMulti",
        placeholder: "Filter by Run...",
        brandRef: { entity: "run" },
        deriveSchema: true,
      },
      {
        // A job joins every submission that scheduled or retried it
        // (`ImageProcessingSubmissionJob`), so this is membership, not a column.
        columnId: "submissionId",
        kind: "multiselect",
        placeholder: "Filter by submission...",
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
      key: "lease-device",
      label: "Current lease device",
      target: "device",
      cardinality: "one",
      provenance: { kind: "query", query: "imageLeaseDevice" },
      inverse: {
        steps: [
          { edge: "Relationship.imageLeaseDevice", direction: "incoming" },
        ],
      },
    },
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
    merge: false,
    lifecycle: "readOnly",
    dataQuality: {
      checks: [
        {
          id: "image_job_failed",
          satisfiedLabel: "Not failed",
          placement: { field: "state" },
          facet: "integrity",
          weight: 3,
          label: "Processing",
          message: "The job failed; its last error and attempts are retained.",
        },
        {
          id: "image_job_unexplained_skip",
          satisfiedLabel: "Skip reason recorded",
          placement: { field: "lastError" },
          facet: "provenance",
          weight: 1,
          label: "Skip reason",
          message: "The job was skipped without a recorded reason.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/image-job/repo",
        export: "imageJobRepository",
      },
    },
  },
});

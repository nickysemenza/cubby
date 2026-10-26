import { z } from "zod";
import {
  shortcodeSchema,
  runShortcode,
  imageShortcode,
  locationShortcode,
} from "../identifier-fields.js";
import {
  jobLane,
  jobState,
  jobWaitReason,
  jobWaitingOnReason,
  JOB_LANE_LABEL,
  JOB_WAITING_ON_LABEL,
} from "../job.js";
import { defineEntity } from "./definition.js";

const readOnly = <T extends z.ZodType>(read: T) => ({
  read,
  create: null,
  update: null,
});
const laneOptions = jobLane.options.map((value) => ({
  value,
  label: JOB_LANE_LABEL[value],
}));
const reasonOptions = jobWaitingOnReason.options.map((value) => ({
  value,
  label: JOB_WAITING_ON_LABEL[value],
}));
const stateOptions = jobState.options.map((value) => ({
  value,
  label: value.replaceAll("_", " "),
}));

/** Execution records are read-only; their owning queue controls their lifecycle. */
export default defineEntity({
  key: "job",
  names: { singular: "Job", plural: "Jobs" },
  route: { basePath: "jobs" },
  table: "Job",
  identifiers: { brand: "JobId", shortcode: "JOB-", shortcodeLength: 10 },
  presentation: {
    titleField: "kind",
    domain: null,
    description:
      "Durable background work, its executor, waits and diagnostics.",
    emptyState: {
      title: "No matching Jobs",
      description: "Background work appears here when it is scheduled.",
    },
    icons: { phosphor: "Robot", sfSymbol: "gearshape", emoji: "⚙️" },
    list: {
      savedViews: [
        {
          id: "in-progress",
          label: "In progress",
          description: "Open execution work, including paused and failed Jobs.",
          filters: [
            {
              id: "state",
              value: ["queued", "running", "retry_wait", "paused", "failed"],
            },
          ],
        },
        {
          id: "due",
          label: "Due",
          description: "Jobs claimable by the server now.",
          filters: [{ id: "reason", value: ["due"] }],
        },
        {
          id: "waiting-for-apple",
          label: "Waiting for Apple",
          description: "Parked work waiting for an Apple device.",
          filters: [{ id: "reason", value: ["waiting_device"] }],
        },
        {
          id: "backing-off",
          label: "Backing off",
          description: "Jobs scheduled for a future retry or provider release.",
          filters: [{ id: "reason", value: ["backing_off"] }],
        },
        {
          id: "attention",
          label: "Needs attention",
          description:
            "Failed Jobs or repeated failures that continue retrying.",
          filters: [{ id: "needsAttention", value: "true" }],
        },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "id",
        kind: "identifier",
        display: { detail: false, list: false },
        validation: readOnly(shortcodeSchema("job")),
      },
      { key: "kind", kind: "text", validation: readOnly(z.string()) },
      {
        key: "lane",
        provenance: {
          kind: "derived",
          sources: [{ label: "Job kind policy" }],
        },
        kind: "enum",
        control: { kind: "select", options: laneOptions },
        display: {
          optionRole: "category",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "Robot", sfSymbol: "gearshape" },
        },
        validation: readOnly(jobLane),
      },
      {
        key: "state",
        kind: "enum",
        control: { kind: "select", options: stateOptions },
        display: { optionRole: "status", optionColor: "neutral-status" },
        validation: readOnly(jobState),
      },
      {
        key: "waitingOn",
        provenance: {
          kind: "derived",
          sources: [{ label: "Job execution state" }],
        },
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "runId",
        kind: "identifier",
        reference: { entity: "run" },
        display: { labelPath: "runName" },
        nullable: true,
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "runName",
        kind: "text",
        nullable: true,
        provenance: { kind: "derived", sources: [{ label: "Run" }] },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "imageId",
        kind: "identifier",
        reference: { entity: "image" },
        nullable: true,
        validation: readOnly(imageShortcode.nullable()),
      },
      {
        key: "locationId",
        kind: "identifier",
        reference: { entity: "location" },
        nullable: true,
        validation: readOnly(locationShortcode.nullable()),
      },
      {
        key: "attempts",
        kind: "number",
        validation: readOnly(z.int().nonnegative()),
      },
      {
        key: "error",
        kind: "text",
        nullable: true,
        display: { columnLabel: "Last error" },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "leaseExpiresAt",
        kind: "timestamp",
        nullable: true,
        display: { columnLabel: "Lease ends", format: "timestamp" },
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
        display: { format: "timestamp" },
        validation: readOnly(z.date()),
      },
      { key: "shortcode", kind: "text" },
      ...["key", "subjectKind", "subjectId"].map((key) => ({
        key,
        kind: "text" as const,
        nullable: key !== "key",
      })),
      {
        key: "waitReason",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: jobWaitReason.options.map((value) => ({
            value,
            label: value.replaceAll("_", " "),
          })),
        },
        display: {
          optionRole: "category",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "Clock", sfSymbol: "clock" },
        },
        validation: readOnly(jobWaitReason.nullable()),
      },
      ...["waitUntil", "lastUsefulProgressAt", "lastClaimedAt"].map((key) => ({
        key,
        kind: "timestamp" as const,
        nullable: true,
      })),
      { key: "availableAt", kind: "timestamp" },
      { key: "leaseToken", kind: "identifier", nullable: true },
      ...["input", "cursor", "result"].map((key) => ({
        key,
        kind: "json" as const,
        nullable: key !== "input",
      })),
      ...["generation", "priority", "maxAttempts"].map((key) => ({
        key,
        kind: "number" as const,
      })),
      { key: "recoveryTimeoutMs", kind: "number", nullable: true },
    ],
    storage: [
      { key: "id", specialized: "primary-key:JobId" },
      { key: "shortcode", specialized: "shortcode" },
      "key",
      "kind",
      { key: "state", specialized: "enum:declaration", defaultValue: "queued" },
      {
        key: "runId",
        reference: "run",
        referenceOptions: { column: "id", onDelete: "set null" },
      },
      "subjectKind",
      "subjectId",
      { key: "waitReason", specialized: "enum:declaration" },
      "waitUntil",
      "input",
      "cursor",
      "result",
      { key: "generation", defaultValue: 1 },
      { key: "priority", defaultValue: 0 },
      { key: "attempts", defaultValue: 0 },
      { key: "maxAttempts", defaultValue: 3 },
      "recoveryTimeoutMs",
      "lastUsefulProgressAt",
      { key: "availableAt", defaultSql: "now()" },
      "leaseToken",
      "leaseExpiresAt",
      "lastClaimedAt",
      "error",
      "createdAt",
      { key: "updatedAt", specialized: "updated-at" },
    ],
    create: [],
    update: [],
    audit: [],
    output: [
      "id",
      "kind",
      "lane",
      "state",
      "waitingOn",
      "runId",
      "runName",
      "imageId",
      "locationId",
      "attempts",
      "error",
      "leaseExpiresAt",
      "createdAt",
      "updatedAt",
    ],
    derived: {
      lane: { type: "enum", options: [...jobLane.options] },
      reason: { type: "enum", options: [...jobWaitingOnReason.options] },
      needsAttention: { type: "boolean" },
      includeInternal: { type: "boolean" },
    },
    sort: {
      fields: [
        "createdAt",
        "updatedAt",
        "kind",
        "state",
        "attempts",
        "leaseExpiresAt",
      ],
    },
  },
  fields: {
    create: null,
    update: null,
    output: { module: "@cubby/schemas/job-entity", export: "jobOut" },
  },
  storage: {
    indexes: [
      { name: "Job_key_unique", unique: true, on: ["key"] },
      { name: "Job_due_idx", on: ["state", "availableAt", "priority"] },
      { name: "Job_run_idx", on: ["runId"] },
      { name: "Job_subject_idx", on: ["subjectKind", "subjectId"] },
      { name: "Job_kind_claimed_idx", on: ["kind", "lastClaimedAt"] },
      { name: "Job_kind_state_idx", on: ["kind", "state", "availableAt"] },
    ],
    checks: [
      { name: "Job_state_check", column: "state", bare: true },
      {
        name: "Job_waitReason_check",
        sql: "{waitReason} IN ('provider_capacity', 'ai_funding_window', 'device', 'rate_limit')",
      },
      {
        name: "Job_subject_check",
        sql: "({subjectKind} IS NULL) = ({subjectId} IS NULL)",
      },
      // Retired kinds have no handler; a pre-cutover Worker's write fails here
      // instead of landing as work nothing serves (ADR 0021 retired refresh.family).
      {
        name: "Job_kind_retired_check",
        sql: "{kind} NOT IN ('image.processing', 'refresh.family')",
      },
      {
        name: "Job_attempts_check",
        sql: "{attempts} >= 0 AND {maxAttempts} > 0",
      },
    ],
  },
  filters: {
    schema: { module: "@cubby/schemas/job-entity", export: "jobFilterFields" },
    descriptors: [
      {
        columnId: "lane",
        kind: "multiselect",
        placeholder: "Lane",
        deriveSchema: true,
        derived: true,
        options: laneOptions,
      },
      {
        columnId: "reason",
        kind: "multiselect",
        placeholder: "Waiting on",
        deriveSchema: true,
        derived: true,
        options: reasonOptions,
      },
      {
        columnId: "state",
        kind: "multiselect",
        placeholder: "State",
        deriveSchema: true,
        options: stateOptions,
      },
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Kind",
        deriveSchema: true,
      },
      {
        columnId: "runId",
        kind: "idMulti",
        placeholder: "Run",
        deriveSchema: true,
        brandRef: { entity: "run" },
      },
      {
        columnId: "needsAttention",
        kind: "boolean",
        placeholder: "Needs attention",
        options: [
          { value: "true", label: "Needs attention" },
          { value: "false", label: "No attention needed" },
        ],
        deriveSchema: true,
        derived: true,
      },
      {
        columnId: "includeInternal",
        kind: "boolean",
        placeholder: "Include internal kinds",
        options: [
          { value: "true", label: "Include internal" },
          { value: "false", label: "Hide internal" },
        ],
        deriveSchema: true,
        derived: true,
      },
    ],
  },
  search: false,
  relations: [
    {
      key: "run",
      label: "Run",
      target: "run",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Job.runId", direction: "outgoing" }],
      },
      inverse: { steps: [{ edge: "Job.runId", direction: "incoming" }] },
    },
  ],
  capabilities: {
    auditable: false,
    images: { storage: false },
    softDelete: false,
    delete: null,
    merge: false,
    lifecycle: "readOnly",
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/job/repo",
        export: "jobRepository",
      },
    },
  },
});

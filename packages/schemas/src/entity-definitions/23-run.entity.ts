import { defineEdge } from "./edges";
import { attachedImageInputs } from "./image-description-inputs";
import { timestampField, readOnly } from "./field-policy";
import { withQuiet } from "./select-control-options.js";
import type { ColorToken, EnumIcon } from "@cubby/shared/enum-palette";
import type { KernelStage } from "../kernel/stage";
import { runChildren } from "../child-tables/run.js";
import { z } from "zod";
import { dateTime } from "../codec";
import {
  ledgerPartyShortcode,
  runShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import {
  RUN_KINDS,
  RUN_PURPOSE_LABEL,
  VISIBLE_RUN_PURPOSES,
  runAiSummary,
  runCause,
  runDisplayStatus,
  runPurpose,
  runRetirementReason,
  runStatus,
  runTrigger,
} from "../run-fields.js";
import { runWorkProgress } from "../run-work-progress.js";
import { progressValueSchema } from "../progress.js";
import { runWaitingOn } from "../run-waiting-on.js";
import { mailRunOutcomeCounts } from "../email-fields.js";
import {
  defineEntity,
  defineEntityModel,
  type EntityPhase,
} from "./definition.js";
import { displayItem, displayItemsField, labelField } from "./label-field.js";

const RUN_PURPOSE_GLYPH = {
  account_sync: { phosphor: "Bank", sfSymbol: "building.columns" },
  mail_import: { phosphor: "Receipt", sfSymbol: "receipt" },
  purchase_validation: { phosphor: "SealCheck", sfSymbol: "checkmark.seal" },
  product_enrichment: { phosphor: "Package", sfSymbol: "shippingbox" },
  photo_inventory: { phosphor: "Camera", sfSymbol: "camera" },
  ai_suggest: { phosphor: "Sparkle", sfSymbol: "sparkles" },
  ai_refresh: { phosphor: "ArrowClockwise", sfSymbol: "arrow.clockwise" },
  background: { phosphor: "Gear", sfSymbol: "gearshape" },
  file_import: { phosphor: "FileArrowUp", sfSymbol: "doc.badge.arrow.up" },
  mail_search: { phosphor: "MagnifyingGlass", sfSymbol: "magnifyingglass" },
  mail_discovery: { phosphor: "Envelope", sfSymbol: "envelope" },
  mail_reclassify: {
    phosphor: "Funnel",
    sfSymbol: "line.3.horizontal.decrease.circle",
  },
  connection_discovery: { phosphor: "Link", sfSymbol: "link" },
  maintenance: { phosphor: "Wrench", sfSymbol: "wrench" },
  derived_refresh: {
    phosphor: "ArrowsClockwise",
    sfSymbol: "arrow.triangle.2.circlepath",
  },
  sweep: { phosphor: "Broom", sfSymbol: "wind" },
} satisfies Record<z.infer<typeof runPurpose>, EnumIcon>;

const RUN_STATUS_OPTIONS = [
  {
    value: "running",
    label: "Running",
    color: "info",
    phase: "active",
    stage: "working",
  },
  {
    value: "paused",
    label: "Paused",
    color: "warning",
    phase: "active",
    stage: "waiting",
  },
  {
    value: "paused_auth",
    label: "Agent authorization needed",
    color: "warning",
    phase: "needs",
    stage: "needs_you",
  },
  {
    value: "paused_offline",
    label: "Paused offline (historical)",
    color: "warning",
    phase: "active",
    stage: "waiting",
  },
  {
    value: "needs_review",
    label: "Needs review",
    color: "warning",
    phase: "needs",
    stage: "needs_you",
  },
  {
    value: "completed",
    label: "Completed",
    color: "positive",
    phase: "finished",
    stage: "done",
  },
  {
    value: "failed",
    label: "Failed",
    color: "destructive",
    phase: "needs",
    stage: "stuck",
  },
  {
    value: "dispatch_failed",
    label: "Dispatch failed",
    color: "destructive",
    phase: "needs",
    stage: "stuck",
  },
] satisfies {
  value: z.infer<typeof runStatus>;
  label: string;
  color: ColorToken;
  phase: EntityPhase;
  stage: KernelStage;
}[];

/**
 * One run: a purchase-agent account sync, validation or enrichment, a
 * photo-inventory batch a member uploads for an agent to work, a Gmail
 * search or scheduled mailbox discovery, or a group of AI calls (decision suggestions on a page, an hour of MCP
 * previews, background work). The record is
 * written only by the run service and the writers; the manifest
 * exposes it read-only so the generic list, detail, inspector and MCP get/list
 * render it like any other record.
 * @public The shortcode registry generator parses this module's `definition` and `readSchemas`.
 */
export const { definition, readSchemas } = defineEntityModel({
  key: "run",
  edges: [
    defineEdge({
      key: "PhotoInventoryEvidence.runId",
      from: "row:PhotoInventoryEvidence",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.PhotoInventoryEvidence.runId",
        from: "run",
        to: "row:PhotoInventoryEvidence",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "PhotoInventoryEvidence.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable workflow evidence retains its source references.",
      },
      fromEnd: {
        role: "reference",
        label: "source",
        description: "The Run that requested the immutable photo observation.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "evidence",
        description: "The Run that requested the immutable photo observation.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "MailHandlingReceipt.runId",
      from: "row:MailHandlingReceipt",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.MailHandlingReceipt.runId",
        from: "run",
        to: "row:MailHandlingReceipt",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "MailHandlingReceipt.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable workflow evidence retains its source references.",
      },
      fromEnd: {
        role: "reference",
        label: "source",
        description: "The Run that retains the mail handling receipt.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "evidence",
        description: "The Run that retains the mail handling receipt.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),

    defineEdge({
      key: "Run.parentRunId",
      from: "run",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.Run.parentRunId",
        from: "run",
        to: "run",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Run.parentRunId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "run",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "child runs",
        description:
          "Work caused by this Run, distinct from its retry attempts.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "Email.runId",
      from: "email",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.Email.runId",
        from: "run",
        to: "email",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Email.runId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "email",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "association",
        label: "mail research assignments",
        description:
          "The durable researcher currently processing a retained mailbox message.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "ImageProcessingJob.runId",
      from: "imageJob",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.ImageProcessingJob.runId",
        from: "run",
        to: "imageJob",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ImageProcessingJob.runId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "imageJob",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "image processing jobs",
        description:
          "An Image job requested by this run. The FK is NO ACTION; the one Run hard delete (routine-run pruning) skips runs with jobs.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Append-only provenance: a job keeps naming the run that scheduled it.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "SourceOrderObservation.runId",
      from: "row:SourceOrderObservation",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.SourceOrderObservation.runId",
        from: "run",
        to: "row:SourceOrderObservation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceOrderObservation.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable source extraction history.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "source order observations",
        description:
          "The Run that captured an immutable source order extraction.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "EmailCandidateObservation.runId",
      from: "row:EmailCandidateObservation",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.EmailCandidateObservation.runId",
        from: "run",
        to: "row:EmailCandidateObservation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "EmailCandidateObservation.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable Email candidate history.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "Email candidate observations",
        description:
          "The original Run that produced this immutable Email evidence.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "EmailClassificationObservation.runId",
      from: "row:EmailClassificationObservation",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.EmailClassificationObservation.runId",
        from: "run",
        to: "row:EmailClassificationObservation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "EmailClassificationObservation.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable Email classification history.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "Email classification observations",
        description:
          "The original Run that produced this immutable Email evidence.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "EmailRetrievalFailure.runId",
      from: "row:EmailRetrievalFailure",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.EmailRetrievalFailure.runId",
        from: "run",
        to: "row:EmailRetrievalFailure",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "EmailRetrievalFailure.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable Email retrieval history.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "Email retrieval failures",
        description:
          "The original Run that produced this immutable Email evidence.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "PhotoRunImage.runId",
      from: "row:PhotoRunImage",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.PhotoRunImage.runId",
        from: "run",
        to: "row:PhotoRunImage",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "PhotoRunImage.runId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "PhotoRunImage.runId",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "owned-child",
        label: "photo work",
        description: "The picker and processing membership owned by this Run.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "AuditLog.runId",
      from: "row:AuditLog",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.AuditLog.runId",
        from: "run",
        to: "row:AuditLog",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "AuditLog.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "History attribution.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "audit entries",
        description: "An audit entry written as part of this run.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Append-only provenance: an audit entry keeps naming the run it belonged to.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "AiUsage.runId",
      from: "row:AiUsage",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.AiUsage.runId",
        from: "run",
        to: "row:AiUsage",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "AiUsage.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Telemetry attribution.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "AI usage",
        description: "One model call made as part of this run.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Append-only provenance: a usage row keeps naming the run it was billed to.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "McpToolCall.runId",
      from: "row:McpToolCall",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.McpToolCall.runId",
        from: "run",
        to: "row:McpToolCall",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "McpToolCall.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Telemetry attribution.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "agent MCP calls",
        description:
          "One Cubby MCP tool call the in-app agent made for this run.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Append-only telemetry: a call keeps naming its run until a hard delete nulls it.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "RunPushRegistration.runId",
      from: "row:RunPushRegistration",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.RunPushRegistration.runId",
        from: "run",
        to: "row:RunPushRegistration",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "RunPushRegistration.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Push delivery state for a device's Run registration, not a relationship.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "owned-child",
        label: "push registrations",
        description:
          "A device's Live Activity or notification push registration for this Run; deleting the Run removes it.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "Suggestion.runId",
      from: "row:Suggestion",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.Suggestion.runId",
        from: "run",
        to: "row:Suggestion",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Suggestion.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Workflow evidence about entities, not a relationship between them.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "Suggestions",
        description:
          "Nullable execution provenance; deleting the Run preserves Suggestions and their decisions.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Field reviews retain execution provenance after archival or deletion.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "RunFinding.runId",
      from: "row:RunFinding",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.RunFinding.runId",
        from: "run",
        to: "row:RunFinding",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "RunFinding.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Workflow evidence about entities, not a relationship between them.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "Findings",
        description:
          "Nullable execution provenance; deleting the Run preserves the finding and its resolutions.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Import findings retain execution provenance after archival or deletion.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "Purchase.runId",
      from: "purchase",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.Purchase.runId",
        from: "run",
        to: "purchase",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Purchase.runId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "purchase",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "purchases",
        description: "A purchase this run imported or validated.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "Run.predecessorRunId",
      from: "run",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.Run.predecessorRunId",
        from: "run",
        to: "run",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Run.predecessorRunId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "run",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "successor runs",
        description: "A later run that continued from this one.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "RunStep.runId",
      from: "row:RunStep",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.RunStep.runId",
        from: "run",
        to: "row:RunStep",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "RunStep.runId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "RunStep.runId",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "owned-child",
        label: "steps",
        description:
          "One ordered step of this step-ledger Run (a backlog or a Suggestion family); deleting the Run removes it.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "RunOperation.runId",
      from: "row:RunOperation",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.RunOperation.runId",
        from: "run",
        to: "row:RunOperation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "RunOperation.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Workflow evidence about entities, not a relationship between them.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "owned-child",
        label: "operations",
        description: "One idempotent operation this run executed.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "RunControlEvent.runId",
      from: "row:RunControlEvent",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.RunControlEvent.runId",
        from: "run",
        to: "row:RunControlEvent",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "RunControlEvent.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Workflow evidence about entities, not a relationship between them.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "owned-child",
        label: "control events",
        description:
          "A prompt, pause, resume, or other control-plane event for this run.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "ImportPreparedOrder.runId",
      from: "row:ImportPreparedOrder",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.ImportPreparedOrder.runId",
        from: "run",
        to: "row:ImportPreparedOrder",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ImportPreparedOrder.runId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Workflow evidence about entities, not a relationship between them.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "owned-child",
        label: "prepared orders",
        description: "Immutable prepared order evidence captured by this run.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "PhotoGroupProposal.runId",
      from: "row:PhotoGroupProposal",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.PhotoGroupProposal.runId",
        from: "run",
        to: "row:PhotoGroupProposal",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "PhotoGroupProposal.runId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "PhotoGroupProposal.runId",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "owned-child",
        label: "photo group proposals",
        description:
          "A proposed item grouping of this photo-inventory run's images.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "ImportSourceClaim.firstRunId",
      from: "row:ImportSourceClaim",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.ImportSourceClaim.firstRunId",
        from: "run",
        to: "row:ImportSourceClaim",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ImportSourceClaim.firstRunId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Workflow evidence about entities, not a relationship between them.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "source claims (first seen)",
        description: "An idempotent source claim first captured by this run.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "ImportSourceClaim.lastRunId",
      from: "row:ImportSourceClaim",
      to: "run",
      cardinality: "one",
      inverse: {
        key: "run.incoming.ImportSourceClaim.lastRunId",
        from: "run",
        to: "row:ImportSourceClaim",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ImportSourceClaim.lastRunId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Workflow evidence about entities, not a relationship between them.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "source claims (last seen)",
        description:
          "An idempotent source claim most recently confirmed by this run.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
  ],

  names: { singular: "Run", plural: "Runs" },
  route: { basePath: "runs" },
  table: "Run",
  children: runChildren,
  identifiers: { brand: "RunId", shortcode: "RUN-" },
  presentation: {
    titleField: "displayName",
    recordIconEntityField: "iconEntity",
    domain: "finance",
    description:
      "Runs: purchase-agent syncs, validations, enrichments, photo-inventory batches, Gmail searches and discovery, and grouped AI work.",
    emptyState: {
      title: "No runs yet",
      description:
        "Runs appear when a vendor account syncs, a purchase is validated or photos are uploaded for inventory.",
    },
    icons: {
      phosphor: "Robot",
      sfSymbol: "arrow.triangle.2.circlepath",
      emoji: "🤖",
    },
    kind: { field: "purpose" },
    state: {
      field: "displayStatus",
      reason: "stateReason",
      wait: "waitingOn",
      stalled: "stalled",
      recentBy: "endedAt",
      recentDays: 7,
    },
    progress: { field: "progressMeter", note: "outcomeLine" },
    detail: {
      lines: [
        { label: "Why", field: "whyLine" },
        { label: "What", field: "whatLine" },
        { label: "Outcome", field: "outcomeLine" },
      ],
      aiSummary: "aiSummary",
      side: { needs: "openItems" },
      // The side column's key facts.
      summary: [
        {
          kind: "fields",
          id: "execution",
          title: "Key facts",
          fields: ["startedAt", "endedAt", "wallTime", "attempt"],
        },
        {
          kind: "fields",
          id: "scope",
          title: "Cost and scope",
          fields: ["chargedCost", "ledgerPartyId", "vendorAccountId"],
        },
        {
          // Both directions of a retry: "Retried as" on the earlier Run,
          // "Retry of" on its successor.
          kind: "fields",
          id: "retries",
          title: "Retries",
          fields: ["successorRunId", "predecessorRunId"],
        },
      ],
      groups: [
        { id: "timeline", title: "Timeline" },
        { id: "results", title: "Results" },
        { id: "evidence", title: "Evidence" },
        { id: "technical", title: "Technical" },
      ],

      activityRelations: [
        { relation: "purchases", dateField: "date" },
        { relation: "emails", dateField: "receivedAt" },
      ],
      omitRelations: {
        purchases:
          "The Changes slot's audit log lists every record the run wrote, purchases included; Purchase stores no run reference to filter by.",
      },
      hero: {
        breadcrumb: "vendorAccountId",
        // `run.control` verbs; the read's `actionReasons` says which apply.
        extraActions: ["retry", "resume", "restart", "pause"],
      },
      quickActions: ["retry", "resume", "restart", "pause"],
      sections: [
        {
          kind: "slot",
          id: "diagnostics",
          group: "timeline",
          title: "Work",
        },
        // What the run did, newest state first.
        {
          kind: "slot",
          id: "import-controls",
          group: "timeline",
          title: "Run controls",
        },
        {
          kind: "slot",
          id: "live-progress",
          group: "timeline",
          title: "Processing",
        },
        {
          kind: "slot",
          id: "steps",
          group: "timeline",
          title: "What the run did",
        },
        {
          kind: "slot",
          id: "import-progress-live",
          group: "timeline",
          title: "Run progress",
        },
        {
          kind: "slot",
          id: "import-agent-live",
          group: "timeline",
          title: "Live agent",
        },
        {
          kind: "slot",
          id: "import-progress-stopped",
          group: "timeline",
          title: "Run progress",
        },
        {
          kind: "slot",
          id: "import-agent-stopped",
          group: "timeline",
          title: "Agent history",
        },
        {
          kind: "slot",
          id: "import-timeline",
          group: "timeline",
          title: "Durable transcript",
        },
        // Review tools: what the run produced for a member.
        {
          kind: "slot",
          id: "evaluations",
          group: "results",
          title: "Evaluation progress",
        },
        {
          kind: "slot",
          id: "photo-batch",
          group: "results",
          title: "Photos",
          placement: "full",
        },
        {
          kind: "slot",
          id: "results",
          group: "results",
          title: "Results",
        },
        {
          kind: "slot",
          id: "decisions",
          group: "results",
          title: "Decisions",
        },
        {
          kind: "slot",
          id: "import-findings",
          group: "results",
          title: "Findings",
        },
        {
          kind: "slot",
          id: "import-prepared-orders",
          group: "results",
          title: "Prepared orders",
        },
        {
          kind: "slot",
          id: "suggestions",
          group: "results",
          title: "Suggestions",
        },
        {
          kind: "slot",
          id: "import-targets",
          group: "results",
          title: "Items and outcomes",
        },
        {
          kind: "slot",
          id: "import-purchases",
          group: "results",
          title: "Purchases changed",
        },
        {
          kind: "slot",
          id: "import-stats",
          group: "results",
          title: "Import counts",
        },
        {
          kind: "slot",
          id: "changes",
          group: "evidence",
          title: "Changes",
        },
        {
          kind: "slot",
          id: "ai-usage",
          group: "evidence",
          title: "AI usage",
        },
        {
          kind: "slot",
          id: "import-debug-log",
          group: "evidence",
          title: "System and agent log",
        },
        // Raw record facts and runtime identity.
        {
          kind: "fields",
          id: "overview",
          title: "Record facts",
          group: "technical",
          fields: [
            "activityAt",
            "status",
            "displayStatus",
            "stateReason",
            "waitingOn",
            "stalled",
            "progressMeter",
            "chargedUnpricedCount",
            "purpose",
            "trigger",
            "routine",
            "vendorId",
            "actorName",
            "retiredAt",
            "retirementReason",
            "failureCode",
            "notes",
            "dispatchError",
            "coordinatorStartedAt",
            "auditedAt",
            "createdAt",
            "updatedAt",
          ],
        },
        {
          kind: "fields",
          id: "runtime",
          group: "technical",
          title: "Runtime",
          fields: [
            "coordinatorModel",
            "skillRevision",
            "runtimeRevision",
            "decisionRevision",
            "parentRunId",
            "cause",
          ],
        },
      ],
    },
    list: {
      layoutRevision: 2,
      // `run.control` verbs; each row's `actionReasons` says which apply.
      extraActions: ["pause", "resume", "retry", "restart"],
      quickActions: ["retry", "resume"],
      titleSubtitle: true,
      rail: [{ field: "startedAt" }, { field: "chargedCost" }],
      // Display images borrow from the vendor; they load as list media.
      // Automatic children of one kind fold into a batch row; member-started
      // and needs-you children always list on their own.
      tree: {
        toggle: true,
        defaultNested: true,
        batch: {
          by: "purpose",
          when: [
            {
              id: "trigger",
              value: ["scheduled", "discovery", "backfill", "ephemeral"],
            },
            // `isMemberStartedRun`: a member request, or a foreground or
            // manual trigger, which the trigger list already leaves out.
            { id: "cause", value: ["__not__:member_request"] },
          ],
        },
      },
      savedViews: [
        {
          id: "imports",
          label: "Imports",
          description:
            "Account syncs, Email imports, validations, enrichments, photo batches, Gmail searches and inbox scans",
          filters: [
            {
              id: "purpose",
              value: [
                "account_sync",
                "mail_import",
                "purchase_validation",
                "product_enrichment",
                "photo_inventory",
                "mail_search",
                "mail_discovery",
              ],
            },
          ],
        },
        {
          id: "ai-work",
          label: "AI work",
          description:
            "Decision-model suggestion passes, hourly AI groups and background AI work",
          filters: [{ id: "purpose", value: ["ai_suggest", "background"] }],
        },
      ],
      // Ephemeral runs only group AI usage (thousands a day), routine kinds
      // are scheduler passes (`RUN_KINDS[*].routine`), and a routine run is a
      // scheduled pass that found nothing; a person opens the list for work
      // somebody started or that changed something. Clearing the filter
      // shows all three. The phase filter bounds Recently finished to
      // `state.recentDays`; Show older adds `older`.
      initialFilter: [
        { id: "phase", value: ["needs", "active", "finished"] },
        {
          id: "trigger",
          value: ["foreground", "discovery", "manual", "backfill", "scheduled"],
        },
        { id: "purpose", value: [...VISIBLE_RUN_PURPOSES] },
        { id: "routine", value: "false" },
      ],
    },
  },
  model: {
    hierarchy: { parentField: "parentRunId", maxDepth: 100 },
    fields: [
      {
        key: "whyLine",
        kind: "json",
        label: "Why",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [
            { label: "Cause" },
            { label: "Parent Run" },
            { label: "Retry of" },
            { label: "Input scope" },
          ],
        },
        explanation: {
          ruleId: "run.why",
          description:
            "Why the Run exists: who started it (You when that is the reader), the Run or import it followed, the Run that found its source, its retry predecessor, or its schedule. Runs whose cause was never recorded show Cause not recorded.",
        },
        display: {
          mobile: { slot: "subtitle", priority: 10 },
          priority: "essential",
          labelPath: "whyLine.title",
          detailLabelPath: "whyLine.title",
        },
        validation: readOnly(displayItem.nullable().default(null)),
      },
      {
        key: "workProgress",
        provenance: {
          kind: "derived",
          sources: [{ label: "Recorded work samples and step counters" }],
        },
        kind: "json",
        label: "Work",
        // Installed native builds read `workProgress.current` through this
        // path; `progressMeter` is the record's progress everywhere else.
        display: {
          columnGroup: "Results",
          detail: false,
          listHidden: true,
          labelPath: "workProgress.current.label",
        },
        validation: readOnly(runWorkProgress.nullable().default(null)),
      },
      {
        key: "progressMeter",
        kind: "json",
        label: "Progress",
        provenance: {
          kind: "derived",
          sources: [
            { label: "Recorded work samples and step counters" },
            { label: "Email outcomes" },
          ],
        },
        explanation: {
          ruleId: "run.progress",
          description:
            "Counts of the Run's work unit: every recorded work phase when they share a unit, else the current phase; a Mail import without work samples counts its Emails by outcome. Remaining items are active while the Run runs, failed once it failed, and queued otherwise.",
        },
        display: {
          columnGroup: "Results",
          priority: "essential",
          // Native, which draws no meter yet, prints the current phase's label.
          labelPath: "workProgress.current.label",
          renderer: { list: "progress" },
        },
        validation: readOnly(progressValueSchema.nullable().default(null)),
      },
      {
        ...labelField("whatLine", "Run kind and input scope"),
        label: "What",
        display: { list: false },
      },
      {
        ...labelField("outcomeLine", "Recorded counts and end state"),
        label: "Outcome",
        display: {
          mobile: { slot: "subtitle", priority: 20 },
          listHidden: true,
        },
      },
      {
        ...labelField("stateReason", "Status, failure and current work"),
        display: { listHidden: true },
      },
      {
        ...displayItemsField("openItems", "Review stops, failures and waits"),
        label: "Needs you",
        display: { list: false, itemsPath: "openItems" },
      },
      {
        key: "aiSummary",
        kind: "json",
        label: "AI-written summary",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ label: "The AI summary written when the Run ended" }],
        },
        explanation: {
          ruleId: "run.ai-summary",
          description:
            "Written once by the fast AI tier after the Run reaches its end state: what it did and what is left for a member. A restarted Run gets a new summary only after it ends again.",
        },
        display: {
          list: false,
          labelPath: "aiSummary.text",
          detailLabelPath: "aiSummary.text",
        },
        validation: readOnly(runAiSummary.nullable().default(null)),
      },
      {
        display: { detail: false, list: false },
        key: "iconEntity",
        kind: "text",
        validation: readOnly(z.string()),
      },
      {
        display: { detail: false, list: false },
        key: "displayName",
        kind: "text",
        validation: readOnly(z.string().min(1)),
      },
      {
        key: "status",
        kind: "enum",
        control: {
          kind: "select",
          options: withQuiet(RUN_STATUS_OPTIONS, "completed"),
        },
        display: {
          columnGroup: "Execution",
          width: "sm",
          listHidden: true,
          priority: "optional",
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(runStatus),
      },
      {
        // The header reads this, so a Run whose open work moved to a retry
        // successor no longer reads "Needs review"; `status` stays the
        // stored, filterable state.
        key: "displayStatus",
        kind: "enum",
        label: "State",
        provenance: {
          kind: "derived",
          sources: [
            { label: "Status" },
            { label: "Retry successor" },
            { label: "AI funding wait" },
          ],
        },
        explanation: {
          ruleId: "run.display-status",
          description:
            "The stored status, except that a Run stopped for review or failed whose open work was carried into a retry reads Retried, and a Run stopped by its AI funding window reads Waiting for AI funding.",
        },
        control: {
          kind: "select",
          options: [
            ...withQuiet(RUN_STATUS_OPTIONS, "completed"),
            {
              value: "retried",
              label: "Retried",
              color: "neutral-status",
              phase: "finished",
              stage: "ended",
            },
            {
              value: "waiting_for_funding",
              label: "Paused: waiting for AI funding",
              color: "warning",
              phase: "needs",
              stage: "waiting",
            },
          ],
        },
        display: {
          columnGroup: "Execution",
          priority: "essential",
          renderer: { list: "state" },
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(runDisplayStatus),
      },
      {
        key: "activityAt",
        provenance: {
          kind: "derived",
          sources: [{ label: "Latest progress, step update, or heartbeat" }],
        },
        kind: "timestamp",
        label: "Activity",
        display: { columnGroup: "Execution" },
        validation: readOnly(z.iso.datetime().nullable().default(null)),
      },
      {
        key: "waitingOn",
        kind: "json",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [
            { label: "The Run's kernel claims" },
            { label: "Queue claim order" },
            { label: "Recent completions of the same kind" },
            { label: "AI funding window" },
          ],
        },
        explanation: {
          ruleId: "run.waiting-on",
          description:
            "The Run’s main kernel wait, its position among due Passes, and an estimate from recent Pass page durations or the wait deadline.",
        },
        // Drawn inside the State badge; the column stays available.
        display: {
          mobile: { slot: "meta", priority: 30 },
          columnGroup: "Execution",
          listHidden: true,
          labelPath: "waitingOn.label",
          detailLabelPath: "waitingOn.label",
        },
        validation: readOnly(runWaitingOn.nullable().default(null)),
      },
      {
        key: "stalled",
        kind: "boolean",
        provenance: {
          kind: "derived",
          sources: [{ label: "Latest kernel claim or completion" }],
        },
        explanation: {
          ruleId: "run.stalled",
          description:
            "Unfinished Passes exceed their progress window, or a requested Ask requires attention.",
        },
        display: { columnGroup: "Execution", width: "sm", listHidden: true },
        validation: readOnly(z.boolean().default(false)),
      },
      {
        key: "chargedCost",
        kind: "number",
        display: {
          columnLabel: "AI cost",
          listHidden: true,
          priority: "optional",
          format: "currency",
          labelPath: "chargedCostLabel",
          detailLabelPath: "chargedCostLabel",
          renderer: { list: "run-ai-cost", detail: "run-ai-cost" },
        },
        provenance: { kind: "derived", sources: [{ label: "Run AI usage" }] },
        validation: readOnly(z.number().default(0)),
      },
      labelField("chargedCostLabel", "Run AI usage"),
      {
        // Calls with no charged price: a zero cost beside them is unknown, not free.
        key: "chargedUnpricedCount",
        kind: "number",
        label: "Unpriced AI calls",
        display: { list: false, format: "count" },
        provenance: { kind: "derived", sources: [{ label: "Run AI usage" }] },
        validation: readOnly(z.number().int().nonnegative().default(0)),
      },
      {
        key: "outcomeCounts",
        kind: "json",
        label: "Email outcomes",
        provenance: {
          kind: "derived",
          sources: [{ label: "The newest outcome of each admitted Email" }],
        },
        explanation: {
          ruleId: "run.outcome-counts",
          description:
            "A Mail import counts each Email by its newest outcome in this Run: imported, linked, unrelated, or an unresolved gap by who settles it (waiting for Cubby, needs research by an agent, needs the member). Other Runs have none.",
        },
        // `outcomeLine` words these; the counts stay on the record for agents.
        display: { list: false, detail: false },
        validation: readOnly(mailRunOutcomeCounts.nullable().default(null)),
      },
      {
        key: "purpose",
        kind: "enum",
        control: {
          kind: "select",
          options: runPurpose.options.map((value) => ({
            value,
            label: RUN_PURPOSE_LABEL[value],
            glyph: RUN_PURPOSE_GLYPH[value],
            description: RUN_KINDS[value].description,
            explanation: RUN_KINDS[value].explanation,
          })),
        },
        display: {
          columnGroup: "Execution",
          width: "sm",
          listHidden: true,
          priority: "optional",
          optionRole: "category",
          optionColor: "domain-finance",
        },
        validation: readOnly(runPurpose),
      },
      {
        key: "trigger",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            {
              value: "foreground",
              label: "Foreground",
              glyph: { phosphor: "AppWindow", sfSymbol: "macwindow" },
            },
            {
              value: "discovery",
              label: "Discovery",
              glyph: { phosphor: "Binoculars", sfSymbol: "binoculars" },
            },
            {
              value: "manual",
              label: "Manual",
              glyph: {
                phosphor: "HandPointing",
                sfSymbol: "hand.point.up.left",
              },
            },
            {
              value: "backfill",
              label: "Backfill",
              glyph: {
                phosphor: "ClockCounterClockwise",
                sfSymbol: "clock.arrow.circlepath",
              },
            },
            {
              value: "scheduled",
              label: "Scheduled",
              glyph: { phosphor: "CalendarBlank", sfSymbol: "calendar" },
            },
            {
              value: "ephemeral",
              label: "Ephemeral",
              glyph: { phosphor: "Lightning", sfSymbol: "bolt" },
            },
          ],
        },
        display: {
          columnGroup: "Execution",
          listHidden: true,
          priority: "optional",
          optionRole: "category",
          optionColor: "domain-finance",
        },
        validation: readOnly(runTrigger),
      },
      {
        // Written when a scheduled run finishes: it completed and its purpose's
        // own count of useful work is zero (`mail_discovery`: no message saved
        // and no history event recorded). Stored, not computed, so list
        // filtering, pagination and counts run on the column everywhere.
        key: "routine",
        kind: "boolean",
        display: { list: false },
        validation: readOnly(z.boolean()),
      },
      {
        key: "vendorAccountId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendorAccount" },
        display: {
          columnGroup: "Scope",
          columnLabel: "Account",
          listHidden: true,
          labelPath: "vendorAccountLabel",
        },
        validation: readOnly(vendorAccountShortcode.nullable()),
      },
      {
        key: "vendorId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendor" },
        display: {
          mobile: { slot: "meta", priority: 20 },
          columnGroup: "Scope",
          listHidden: true,
          labelPath: "vendorName",
        },
        validation: readOnly(vendorShortcode.nullable()),
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        // Null only on runs that group AI work (see `ensureRun`); import
        // purposes always carry the member scope (`Run_import_party_check`).
        nullable: true,
        reference: { entity: "ledgerParty" },
        display: {
          columnGroup: "Scope",
          listHidden: true,
          labelPath: "ledgerPartyName",
        },
        validation: readOnly(ledgerPartyShortcode.nullable()),
      },
      {
        key: "actorName",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "startedAt",
        kind: "timestamp",
        display: {
          columnGroup: "Execution",
          listHidden: true,
          format: "timestamp",
        },
        validation: readOnly(dateTime),
      },
      {
        key: "endedAt",
        kind: "timestamp",
        nullable: true,
        display: {
          columnGroup: "Execution",
          listHidden: true,
          format: "timestamp",
        },
        validation: readOnly(dateTime.nullable()),
      },
      {
        key: "retiredAt",
        kind: "timestamp",
        nullable: true,
        display: { list: false, format: "timestamp" },
        validation: readOnly(dateTime.nullable()),
      },
      {
        key: "retirementReason",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: [
            {
              value: "unrelated_source",
              label: "Unrelated source removed",
            },
            {
              value: "settled",
              label: "Settled; transcript destroyed",
            },
          ],
        },
        display: {
          list: false,
          optionRole: "category",
          optionColor: "domain-finance",
          optionGlyph: { phosphor: "Archive", sfSymbol: "archivebox" },
        },
        validation: readOnly(runRetirementReason.nullable()),
      },
      {
        key: "wallTime",
        kind: "text",
        display: { list: false },
        provenance: {
          kind: "derived",
          sources: [{ label: "Run start and end times" }],
        },
        explanation: {
          ruleId: "import-run.wall-time",
          description:
            "Elapsed time from the run's start to its end. An active run is shown as in progress.",
          readPath: "wallTime",
          sourceDependencies: [
            { path: "startedAt", label: "Started at" },
            { path: "endedAt", label: "Ended at" },
          ],
        },
        validation: readOnly(z.string()),
      },
      {
        key: "ordersSeen",
        kind: "number",
        display: {
          columnGroup: "Results",
          detail: false,
          listHidden: true,
          priority: "optional",
          width: "sm",
        },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "imported",
        kind: "number",
        display: {
          columnGroup: "Results",
          detail: false,
          listHidden: true,
          priority: "optional",
          width: "sm",
        },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "updated",
        kind: "number",
        display: {
          columnGroup: "Results",
          detail: false,
          listHidden: true,
          priority: "optional",
          width: "sm",
        },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "skipped",
        kind: "number",
        display: {
          columnGroup: "Results",
          detail: false,
          listHidden: true,
          priority: "optional",
          width: "sm",
        },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "failureCode",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "coordinatorModel",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "skillRevision",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "runtimeRevision",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "decisionRevision",
        kind: "number",
        display: { list: false },
        validation: readOnly(z.number().int()),
      },
      {
        key: "dispatchError",
        label: "Failure details",
        kind: "text",
        nullable: true,
        display: { list: false, renderer: { detail: "run-failure-details" } },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "coordinatorStartedAt",
        kind: "timestamp",
        nullable: true,
        display: { list: false, format: "timestamp" },
        validation: readOnly(dateTime.nullable()),
      },
      {
        key: "auditedAt",
        kind: "timestamp",
        nullable: true,
        display: { list: false, format: "timestamp" },
        validation: readOnly(dateTime.nullable()),
      },
      {
        key: "predecessorRunId",
        kind: "identifier",
        nullable: true,
        label: "Retry of",
        reference: { entity: "run" },
        display: { list: false },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "successorRunId",
        kind: "identifier",
        nullable: true,
        label: "Retried as",
        // Read from the newest Run whose `predecessorRunId` names this one.
        reference: { entity: "run" },
        explanation: {
          ruleId: "run.successor",
          description:
            "The newest retry or restart whose Retry of names this Run.",
        },
        display: { list: false },
        validation: readOnly(runShortcode.nullable().default(null)),
      },
      {
        // The action-state port: why `run.control` would refuse each row verb, null when it
        // would run. The control rechecks ownership and the work it carries.
        key: "actionReasons",
        kind: "json",
        display: { detail: false, list: false },
        validation: readOnly(
          z.record(z.string(), z.string().nullable()).nullable().default(null),
        ),
      },
      {
        key: "parentRunId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "run" },
        display: { list: false },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "cause",
        kind: "enum",
        nullable: true,
        display: {
          list: false,
          optionRole: "category",
          optionColor: "domain-finance",
          optionGlyph: { phosphor: "Lightning", sfSymbol: "bolt" },
        },
        control: {
          kind: "select",
          options: runCause.options.map((value) => ({
            value,
            label: value.replaceAll("_", " "),
          })),
        },
        validation: readOnly(runCause.nullable()),
      },
      {
        key: "attempt",
        kind: "number",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.number().int().positive().nullable()),
      },
      {
        display: {},
        key: "vendorAccountLabel",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "vendorName",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "ledgerPartyName",
        kind: "text",
        // Null with `ledgerPartyId` on runs that group AI work.
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: readOnly(runShortcode),
      },
      timestampField("createdAt"),
      timestampField("updatedAt"),
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    // The actor snapshot, dispatch fencing and history walk columns stay
    // hand-written on the table: they reference the auth user table, the run
    // itself, or are operational state no surface presents.
    storage: [
      {
        key: "id",
        specialized: "primary-key:RunId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "ledgerPartyId",
      "actorName",
      "vendorAccountId",
      "vendorId",
      {
        key: "purpose",
        defaultValue: "account_sync",
        specialized: "enum:purpose",
      },
      { key: "trigger", specialized: "enum:trigger" },
      { key: "cause", specialized: "enum:cause" },
      "attempt",
      "parentRunId",
      {
        key: "status",
        defaultValue: "running",
        specialized: "enum:status",
      },
      {
        key: "coordinatorModel",
        defaultValue: "gpt-6-sol",
      },
      {
        key: "skillRevision",
        defaultValue: "purchase-import@1",
      },
      {
        key: "runtimeRevision",
        defaultValue: "pi-durable@1",
      },
      { key: "decisionRevision", defaultValue: 1 },
      { key: "startedAt", defaultOverride: "now" },
      "endedAt",
      "retiredAt",
      "retirementReason",
      { key: "ordersSeen", defaultValue: 0 },
      { key: "imported", defaultValue: 0 },
      { key: "updated", defaultValue: 0 },
      { key: "skipped", defaultValue: 0 },
      { key: "routine", defaultValue: false },
      "auditedAt",
      "failureCode",
      "notes",
      "dispatchError",
      "coordinatorStartedAt",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],

    derived: {
      stalled: { type: "boolean" },
      needsAttention: { type: "boolean" },
      displayStatus: { type: "enum", options: [...runDisplayStatus.options] },
    },
    sort: {
      fields: [
        "startedAt",
        "stalled",
        "endedAt",
        "status",
        "purpose",
        "ordersSeen",
        "imported",
      ],
    },
  },
  fields: {
    create: null,
    update: null,
  },
  // One durable attempt to discover, fetch, extract, write, and audit evidence.
  storage: {
    // The actor snapshot, the run's own lineage, dispatch fencing and the
    // history walk are operational state outside the model.
    columns: [
      {
        key: "actorUserId",
        kind: "text",
        notNull: true,
        type: { module: "@cubby/schemas/identifiers", export: "UserId" },
        reference: "user",
      },
      { key: "actorEmail", kind: "text", notNull: true },
      // Null when the actor has no member party (the system user).
      { key: "actorLedgerPartyShortcode", kind: "text" },
      { key: "actorLedgerPartyName", kind: "text" },
      { key: "actorLedgerPartyKind", kind: "text" },
      {
        key: "predecessorRunId",
        kind: "identifier",
        type: { module: "@cubby/schemas/identifiers", export: "RunId" },
      },
      // Stable queue generation; duplicate and late deliveries are fenced to it.
      { key: "dispatchEventId", kind: "text" },
      { key: "agentSessionId", kind: "text" },
      // Caller attribution for the work the run groups (see `ActorContext`).
      {
        key: "channel",
        kind: "text",
        notNull: true,
        type: { module: "@cubby/schemas/context", export: "AuditChannel" },
        defaultValue: "web",
      },
      // Deliberately not FKs, like `McpToolCall.clientId`: a run keeps naming
      // the client and install that started it after either is removed.
      { key: "oauthClientId", kind: "text" },
      {
        key: "deviceId",
        kind: "identifier",
        type: { module: "@cubby/schemas/identifiers", export: "DeviceId" },
      },
      // Client-minted grouping key, e.g. one decision pass per page mount.
      { key: "clientKey", kind: "text" },
      // What the run was asked to do; the shape belongs to its purpose.
      {
        key: "input",
        kind: "json",
        type: { module: "@cubby/schemas/run-fields", export: "RunInput" },
      },
      {
        key: "liveProgress",
        kind: "json",
        type: {
          module: "@cubby/schemas/run-fields",
          export: "RunLiveProgressEvent",
        },
      },
      {
        key: "progressHistory",
        kind: "json",
        type: {
          module: "@cubby/schemas/run-fields",
          export: "RunProgressHistory",
        },
      },
      // Display history is bounded; replay identity is retained for the Run's lifetime.
      {
        key: "progressEventIds",
        kind: "json",
        type: {
          module: "@cubby/schemas/run-fields",
          export: "RunProgressEventIds",
        },
      },
      { key: "heartbeatAt", kind: "timestamp" },
      // Resumable position within `input`; the shape belongs to its purpose.
      {
        key: "progress",
        kind: "json",
        type: { module: "@cubby/schemas/run-fields", export: "RunProgress" },
      },
    ],
    indexes: [
      {
        // Current execution and repair reads must not scan retained Run payloads.
        name: "Run_live_status_failure_purpose_idx",
        on: ["status", "failureCode", "purpose"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "Run_party_started_idx",
        on: ["ledgerPartyId", { column: "startedAt", desc: true }],
      },
      { name: "Run_parent_started_idx", on: ["parentRunId", "startedAt"] },
      {
        // The AI summary admission scans ended non-ephemeral Runs by end time.
        name: "Run_ended_summary_idx",
        on: [{ column: "endedAt", desc: true }],
        where:
          "{endedAt} IS NOT NULL AND {trigger} <> 'ephemeral' AND {purpose} NOT IN ('ai_suggest', 'background')",
      },
      {
        // Mail import's attempted-revision probes otherwise read every Run input.
        name: "Run_party_evidenceRevision_idx",
        on: ["ledgerPartyId", { sql: "({input}->>'evidenceRevision')" }],
        where: "({input}->>'evidenceRevision') IS NOT NULL",
      },
      {
        name: "Run_vendorAccount_started_idx",
        on: ["vendorAccountId", { column: "startedAt", desc: true }],
      },
      {
        name: "Run_clientKey_unique",
        on: ["clientKey"],
        unique: true,
        where: "{clientKey} IS NOT NULL",
      },
      {
        name: "Run_dispatch_event_unique",
        on: ["dispatchEventId"],
        unique: true,
        where: "{dispatchEventId} IS NOT NULL",
      },
      {
        name: "Run_one_active_vendor_account_key",
        on: ["vendorAccountId"],
        unique: true,
        where:
          "{vendorAccountId} IS NOT NULL AND {status} IN ('running', 'paused', 'paused_auth', 'paused_offline')",
      },
      {
        // The admission owner enforces capacity and exclusive scopes. The index
        // independently refuses two running owners of the same query resource.
        name: "Run_one_active_mail_discovery",
        on: [
          "ledgerPartyId",
          { sql: "COALESCE({input}->>'mailboxId', '')" },
          {
            sql: "md5(COALESCE(CASE WHEN {progress}->'discoveryScope'->>'kind' = 'query' THEN {progress}->'discoveryScope'->>'key' END, ''))",
          },
        ],
        unique: true,
        where: "{purpose} = 'mail_discovery' AND {status} = 'running'",
      },
      {
        // One maintenance pass at a time: a cron and a "Run now" racing each
        // other lose the insert and return the active pass instead.
        name: "Run_one_active_maintenance",
        on: ["purpose"],
        unique: true,
        where:
          "{purpose} = 'maintenance' AND {status} IN ('running', 'paused_auth')",
      },
    ],
    checks: [
      { column: "trigger" },
      {
        name: "Run_import_party_check",
        sql: "{purpose} NOT IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'mail_discovery') OR ({ledgerPartyId} IS NOT NULL AND {actorLedgerPartyShortcode} IS NOT NULL)",
      },
      {
        column: "channel",
        values: ["web", "api", "mcp", "caldav", "system"],
      },
      { column: "status" },
      { column: "purpose" },
      { column: "cause" },
      {
        name: "Run_attempt_positive",
        sql: "{attempt} IS NULL OR {attempt} > 0",
      },
      {
        name: "Run_photo_inventory_no_vendor_check",
        sql: "{purpose} <> 'photo_inventory' OR {vendorAccountId} IS NULL",
      },
    ],
    unindexedReferences: {
      vendorId: "runs are listed by vendor account, never by vendor alone",
      actorUserId: "runs are listed by ledger party; the user is a snapshot",
    },
  },
  filters: {
    descriptors: [
      {
        columnId: "retirementReason",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter by retirement reason...",
      },
      {
        columnId: "cause",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter by cause...",
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        schemaFromRead: true,
        options: [
          { value: "running", label: "Running", color: "var(--info)" },
          { value: "paused", label: "Paused", color: "var(--warning)" },
          {
            value: "paused_auth",
            label: "Agent authorization needed",
            color: "var(--warning)",
          },
          {
            value: "paused_offline",
            label: "Paused offline (historical)",
            color: "var(--warning)",
          },
          {
            value: "needs_review",
            label: "Needs review",
            color: "var(--warning)",
          },
          {
            value: "completed",
            label: "Completed",
            color: "var(--positive)",
          },
          { value: "failed", label: "Failed", color: "var(--destructive)" },
          {
            value: "dispatch_failed",
            label: "Dispatch failed",
            color: "var(--destructive)",
          },
        ],
      },
      {
        columnId: "purpose",
        kind: "multiselect",
        placeholder: "Filter by purpose...",
        deriveSchema: true,
        schemaFromRead: true,
      },
      {
        columnId: "trigger",
        kind: "multiselect",
        placeholder: "Filter by trigger...",
        deriveSchema: true,
        schemaFromRead: true,
      },
      {
        columnId: "needsAttention",
        kind: "boolean",
        placeholder: "Needs attention",
        deriveSchema: true,
        derived: true,
        options: [
          { value: "true", label: "Needs attention" },
          { value: "false", label: "No attention needed" },
        ],
      },
      {
        columnId: "stalled",
        kind: "boolean",
        placeholder: "Stalled",
        deriveSchema: true,
        derived: true,
        options: [
          { value: "true", label: "Stalled" },
          { value: "false", label: "Not stalled" },
        ],
      },
      {
        columnId: "routine",
        field: "routine",
        kind: "boolean",
        placeholder: "Filter routine runs...",
        deriveSchema: true,
        schemaDescription:
          "Filter scheduled runs that completed without finding anything",
        options: [
          { value: "true", label: "Routine" },
          { value: "false", label: "Not routine" },
        ],
      },
      {
        columnId: "vendorAccountId",
        kind: "idMulti",
        placeholder: "Filter by vendor account...",
        brandRef: { entity: "vendorAccount" },
        deriveSchema: true,
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        brandRef: { entity: "vendor" },
        deriveSchema: true,
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by member...",
        brandRef: { entity: "ledgerParty" },
        currentMember: true,
        deriveSchema: true,
      },
      {
        columnId: "parentRunId",
        kind: "idMulti",
        placeholder: "Filter by parent Run...",
        brandRef: { entity: "run" },
        deriveSchema: true,
      },
      {
        columnId: "startedAt",
        label: "Started",
        kind: "range",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter by start time...",
      },
      {
        columnId: "endedAt",
        label: "Ended",
        kind: "range",
        deriveSchema: true,
        stored: true,
        wire: {
          kind: "range",
          from: "endedAtFrom",
          to: "endedAtTo",
          presence: "endedAtPresenceFilter",
        },
        placeholder: "Filter by end time...",
        options: [
          { value: "has", label: "Has ended", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "retiredAt",
        label: "Retired",
        kind: "range",
        deriveSchema: true,
        stored: true,
        wire: {
          kind: "range",
          from: "retiredAtFrom",
          to: "retiredAtTo",
          presence: "retiredAtPresenceFilter",
        },
        placeholder: "Filter by retirement time...",
        options: [
          { value: "has", label: "Retired", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "coordinatorStartedAt",
        label: "Coordinator started",
        kind: "range",
        deriveSchema: true,
        stored: true,
        wire: {
          kind: "range",
          from: "coordinatorStartedAtFrom",
          to: "coordinatorStartedAtTo",
          presence: "coordinatorStartedAtPresenceFilter",
        },
        placeholder: "Filter by coordinator start...",
        options: [
          { value: "has", label: "Coordinator started", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "auditedAt",
        label: "Audited",
        kind: "range",
        deriveSchema: true,
        stored: true,
        wire: {
          kind: "range",
          from: "auditedAtFrom",
          to: "auditedAtTo",
          presence: "auditedAtPresenceFilter",
        },
        placeholder: "Filter by audit time...",
        options: [
          { value: "has", label: "Audited", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "createdAt",
        label: "Created",
        kind: "range",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter by created date...",
      },
      {
        columnId: "updatedAt",
        label: "Updated",
        kind: "range",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter by updated date...",
      },
    ],
  },

  search: false,
  capabilities: {
    auditable: false,
    images: {
      storage: false,
    },
    softDelete: false,
    delete: null,
    merge: false,
    // The run service and import writers own every write.
    lifecycle: "readOnly",
    dataQuality: {
      listHidden: true,
      // Rows the stored evaluator reads beyond its own row (ADR 0021).
      inputs: [
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [{ table: "Run", from: "vendorId", to: "id" }],
        },
        ...attachedImageInputs([
          { table: "Vendor", from: "id", to: "id" },
          { table: "Run", from: "vendorId", to: "id" },
        ]),
        { table: "PhotoRunImage", match: { runId: "id" } },
        { table: "RunOperation", match: { runId: "id" } },
      ],
      checks: [
        {
          id: "run_attribution",
          satisfiedLabel: "Actor attributed",
          placement: { field: "actorName" },
          facet: "provenance",
          kind: "defect",
          label: "Actor attribution",
          message: "The run has no recorded actor name.",
        },
        {
          id: "run_timeline",
          satisfiedLabel: "Timeline recorded",
          placement: { section: "import-timeline" },
          facet: "integrity",
          kind: "defect",
          label: "Run timeline",
          message:
            "The run ends before it starts or its terminal status has no end time.",
        },
        {
          id: "run_target_outcomes",
          satisfiedLabel: "Target outcomes recorded",
          placement: { section: "import-targets" },
          facet: "integrity",
          kind: "defect",
          label: "Target outcomes",
          message:
            "A completed targeted run has no targets or has an unfinished or unexplained target outcome.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      reports: {
        module: "~/server/domains/run/repo/report-bindings",
        export: "reportBindings",
      },
      repository: {
        module: "~/server/domains/run/repo/run",
        export: "runRepository",
      },
    },
  },
});

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      r.declare(
        r
          .path("image", "many", [
            { edge: "PhotoRunImage.runId", direction: "incoming" },
            { edge: "PhotoRunImage.imageId", direction: "outgoing" },
          ])
          .named("source-images", "Source images"),
        "image.run.source-images",
      ),
      r.declare(
        r.field("vendorAccountId").named("vendor-account", "Vendor account"),
        "vendorAccount.runs",
      ),
      r.declare(r.field("vendorId").named("vendor", "Vendor"), "vendor.runs"),
      r.declare(
        r.field("ledgerPartyId").named("ledger-party", "Member"),
        "ledgerParty.runs",
      ),
      r.declare(
        r.field("predecessorRunId").named("predecessor", "Predecessor", {
          inverseOmit:
            "A run links its predecessor; a retry chain is short and read from the newest run back.",
        }),
        "run.run.predecessor",
      ),
      r.declare(
        r.field("parentRunId").named("parent", "Parent Run"),
        "run.children",
      ),
      r.declare(
        r
          .path("run", "many", [
            { edge: "Run.parentRunId", direction: "incoming" },
          ])
          .named("children", "Child Runs"),
        "run.parent",
      ),
      r.declare(
        r
          .path("purchase", "many", [
            { edge: "Purchase.runId", direction: "incoming" },
          ])
          .named("purchases", "Purchases"),
        "purchase.run.purchases",
      ),
    ],
  }),
  readSchemas,
);

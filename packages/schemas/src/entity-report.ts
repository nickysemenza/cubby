import { z } from "zod";

import {
  COLLECTION_ACTIONS,
  type CollectionActionId,
} from "./entity-definitions/collection-actions";
import { SECTION_ACTION_IDS } from "./entity-section-actions";
import { runShortcode } from "./identifiers";
import { runControlAction } from "./run-fields";

/**
 * The generic read a detail slot draws on every client. The server composes
 * each figure, series and schedule row once (money only from
 * SUM(Expense.cost) or the persisted valuation); web and native render the
 * block kinds below and derive nothing. A block kind earns its place by
 * repeating across slots: `stats` (labelled figures), `chart` (labelled
 * values, bar/stack/line), `table`, `schedule` (dated spans) and `note`.
 */
export const reportSlots = [
  "project.budget",
  "project.contribution",
  "project.analytics",
  "project.schedule",
  "location.contents-valuation",
  "meal.composition",
  "product.labels",
  "product.cookbooks",
  "product.recipe-appearances",
  "image.associations",
  "purchase.runs",
  "location.ai-description",
  "purchase.reconciliation",
  "purchase.project-allocation",
  "purchase.financial-settlement",
  "expense.settlement",
  "vendorAccount.charge-search",
  // A Run's detail: progress, approvals, findings, transcript, log, AI usage and changes.
  "run.live-progress",
  "run.import-stats",
  "run.import-progress-live",
  "run.import-progress-stopped",
  "run.import-purchases",
  "run.import-approvals",
  "run.import-findings",
  "run.import-targets",
  "run.import-evidence",
  "run.import-timeline",
  "run.import-debug-log",
  "run.ai-usage",
  "run.changes",
] as const;
export const reportSlot = z.enum(reportSlots);

/**
 * The verbs on the record each `records` slot belongs to. The server puts them on the block, and
 * web shows them from this table so they stay available while the report loads or fails.
 */
export const reportSlotActions = {
  "image.associations": ["attachImage"],
  "location.ai-description": ["analyzeLocation"],
  "purchase.runs": ["validatePurchase"],
} as const satisfies Partial<
  Record<(typeof reportSlots)[number], readonly CollectionActionId[]>
>;

/** The verbs a slot offers on its record (none for most slots). */
export const slotActionsOf = (slot: string): readonly CollectionActionId[] =>
  Object.entries(reportSlotActions).find(([key]) => key === slot)?.[1] ?? [];

/**
 * The evidence a saved label reading cites, shared so the server's "is there anything new to
 * review" and the review itself agree.
 */
export const labelNutritionSource = (imageId: string, analysisAt: string) =>
  `Package label ${imageId} · analysis ${analysisAt}`;
export type ReportSlot = z.infer<typeof reportSlot>;

export const entityReportInput = z.object({
  slot: reportSlot,
  /** The record's public shortcode; its prefix must match the slot's entity. */
  id: z.string().min(1),
  /** The next page of a paged report (`nextCursor` of the previous one). */
  cursor: z.string().min(1).optional(),
});
export type EntityReportInput = z.infer<typeof entityReportInput>;

/**
 * Several slots of one record in one read. A page that shows many slots of the same record
 * (a Run) polls this once, and the server loads the record once for all of them.
 */
export const entityReportManyInput = z.object({
  slots: z.array(reportSlot).min(1).max(16),
  id: z.string().min(1),
});
export type EntityReportManyInput = z.infer<typeof entityReportManyInput>;

const reportTone = z.enum(["positive", "warning", "destructive", "muted"]);
const reportFormat = z.enum(["money", "count", "text"]);

/** A record a row or bar links to. */
const reportRef = z.object({
  entity: z.enum(["project", "recipe"]),
  id: z.string(),
});

const reportStats = z.object({
  kind: z.literal("stats"),
  title: z.string().optional(),
  figures: z.array(
    z.object({
      label: z.string(),
      /** Null renders as an em dash (no estimate to measure against). */
      value: z.number().nullable(),
      format: reportFormat,
      /** The figure for a `text` format (a verdict), already worded. */
      text: z.string().optional(),
      tone: reportTone.optional(),
    }),
  ),
});

const reportChart = z.object({
  kind: z.literal("chart"),
  title: z.string().optional(),
  /** `stack` draws the series as one segmented bar against `marker`. */
  mark: z.enum(["bar", "stack", "line"]),
  format: reportFormat,
  series: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      tone: reportTone.optional(),
      ref: reportRef.optional(),
    }),
  ),
  /** The reference value a `stack` is measured against (the estimate). */
  marker: z.number().optional(),
  caption: z.string().optional(),
});

const reportTable = z.object({
  kind: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(z.string()),
  /** Cells are display text composed by the server, one per column. */
  rows: z.array(
    z.object({
      id: z.string(),
      cells: z.array(z.string()),
      ref: reportRef.optional(),
    }),
  ),
  empty: z.string().optional(),
  truncated: z.boolean().optional(),
});

const reportSegment = z.object({
  id: z.string(),
  label: z.string(),
  startDate: z.string(),
  endDate: z.string().optional(),
  variant: z.enum(["range", "milestone"]),
});

const reportScheduleRow = z.object({
  id: z.string(),
  entity: z.enum(["project", "task"]),
  name: z.string(),
  /** Nesting depth in the tree; rows arrive in display (pre-)order. */
  depth: z.number().int().nonnegative(),
  expandable: z.boolean(),
  meta: z.string(),
  metaShort: z.string(),
  segments: z.array(reportSegment),
  noDateLabel: z.string().optional(),
  blockedByIds: z.array(z.string()),
  blockingIds: z.array(z.string()),
});
export type ReportScheduleRow = z.infer<typeof reportScheduleRow>;

const reportSchedule = z.object({
  kind: z.literal("schedule"),
  rows: z.array(reportScheduleRow),
});

const reportNote = z.object({
  kind: z.literal("note"),
  text: z.string(),
  /** A status sentence rather than a caption. */
  strong: z.boolean().optional(),
  tone: reportTone.optional(),
});

/**
 * What a row command runs. Each member names one existing operation and carries its exact body,
 * so a client never assembles a request from a label; `confirm` is shown before it is sent and
 * null means one tap acts.
 */
export const reportCommandRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run-control"),
    runId: runShortcode,
    action: runControlAction,
    operationId: z.string().min(1).nullable(),
    approvalId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("resolve-finding"),
    findingId: z.uuid(),
    decision: z.enum(["apply", "dismiss"]),
    reviewedFingerprint: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("retry-gmail-search"),
    runId: runShortcode,
  }),
]);
export type ReportCommandRequest = z.infer<typeof reportCommandRequest>;

export const reportCommand = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** The main command of its row; the rest draw as secondary. */
  prominent: z.boolean(),
  confirm: z.string().min(1).nullable(),
  request: reportCommandRequest,
});
export type ReportCommand = z.infer<typeof reportCommand>;

const reportRecordRow = z.object({
  /** The record the row opens (any entity key), or null for a row that only reads. */
  entity: z.string().nullable(),
  id: z.string().nullable(),
  title: z.string(),
  /** Display text composed by the server; lines are joined with "\n". */
  subtitle: z.string().nullable(),
  trailing: z.string().nullable(),
  /** A thumbnail the row leads with. */
  imageUrl: z.string().optional(),
  /** Short chips worded by the server (a status, a failure code). */
  badges: z.array(z.string()).optional(),
  /** An ISO instant each client prints in its own locale and zone. */
  at: z.string().optional(),
  /** The list of other records this row summarises, opened as the trailing link. */
  listLink: z
    .object({
      entity: z.string(),
      /** Filter values keyed by the list's URL key. */
      filters: z.record(z.string(), z.string()),
    })
    .optional(),
  /** Row verbs offered on this row only (the server decides when one applies). */
  actions: z.array(z.enum(COLLECTION_ACTIONS)).optional(),
  /** What a checked row or a section verb acts on, when that is not the opened record. */
  key: z.string().optional(),
  /** Why the row cannot be checked; absent or null when it can. */
  disabledReason: z.string().nullable().optional(),
  /** Status chips with a tone (a run's approvals, findings and operations). */
  statuses: z
    .array(z.object({ label: z.string(), tone: reportTone.optional() }))
    .optional(),
  /** Lines under the title, each with its own tone. */
  lines: z
    .array(z.object({ text: z.string(), tone: reportTone.optional() }))
    .optional(),
  /** Raw material kept out of the way (an operation's arguments). */
  detail: z.object({ label: z.string(), text: z.string() }).optional(),
  /** Commands on this row: each runs an existing operation after its declared confirmation. */
  commands: z.array(reportCommand).optional(),
});
export type ReportRecordRow = z.infer<typeof reportRecordRow>;

/**
 * Rows that are records of their own (cookbooks a product is a copy of, the photos of a label, the
 * import runs of a purchase) with the verbs the slot offers. `actions` name
 * `COLLECTION_ACTION_SCOPES` verbs: web fills each in `collection-actions.tsx`, native runs the
 * plan in `nativeCollectionActionPlans`.
 */
const reportRecords = z.object({
  kind: z.literal("records"),
  title: z.string().optional(),
  rows: z.array(reportRecordRow),
  empty: z.string(),
  /** Verbs on the record the slot belongs to (`reportSlotActions`). */
  actions: z.array(z.enum(COLLECTION_ACTIONS)).optional(),
  /** `large` for evidence photos that must stay legible (a package label). */
  thumbnail: z.enum(["small", "large"]).optional(),
  /** One line under the rows, such as a total. */
  footer: z.string().optional(),
  /**
   * Finance verbs (`SECTION_ACTION_IDS`) with the server's word on each: a verb with a
   * `disabledReason` is shown unavailable with it, and a `selection` verb acts on the checked
   * rows (never a row with a `disabledReason`). Each runs an existing operation on every client
   * that implements it; `native-coverage.ts` classifies the rest.
   */
  verbs: z
    .array(
      z.object({
        id: z.enum(SECTION_ACTION_IDS),
        label: z.string(),
        scope: z.enum(["section", "selection"]),
        disabledReason: z.string().nullable(),
      }),
    )
    .optional(),
});

export const reportBlock = z.discriminatedUnion("kind", [
  reportStats,
  reportChart,
  reportTable,
  reportSchedule,
  reportNote,
  reportRecords,
]);
export type ReportBlock = z.infer<typeof reportBlock>;

export const entityReportOut = z.object({
  blocks: z.array(reportBlock),
  /** The record is still moving; clients poll while true. */
  live: z.boolean().optional(),
  /** The record's status as of this read; a client showing another refreshes its record. */
  status: z.string().optional(),
  /** More of the same report; pass it back as `cursor`. */
  nextCursor: z.string().optional(),
});
export type EntityReportOut = z.infer<typeof entityReportOut>;

export const entityReportManyOut = z.object({
  reports: z.array(z.object({ slot: reportSlot, report: entityReportOut })),
});
export type EntityReportManyOut = z.infer<typeof entityReportManyOut>;

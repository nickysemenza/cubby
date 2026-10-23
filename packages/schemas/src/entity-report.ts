import { z } from "zod";
import { reportScope } from "./entity-report-scope";

import {
  COLLECTION_ACTIONS,
  type CollectionActionId,
} from "./entity-definitions/collection-actions";
import { SECTION_ACTION_IDS } from "./entity-section-actions";
import { cookbookShortcode, runShortcode } from "./identifiers";
import {
  workflowCommandRequest,
  workflowCommandInput,
} from "./workflow-command";

/**
 * The generic read a detail slot draws on every client. The server composes
 * each figure, series and schedule row once (money only from
 * SUM(Expense.cost) or the persisted valuation); web and native render the
 * block kinds below and derive nothing. A block kind earns its place by
 * repeating across slots: `stats` (labelled figures), `chart` (labelled
 * values, bar/stack/line), `table`, `schedule` (dated spans) and `note`.
 */
export const reportSlots = [
  "task.briefing",
  "shipment.tracking",
  "email.review",
  "recipe.availability",
  "recipe.costing-coverage",
  "recipe.walkthrough",
  "project.budget",
  "project.contribution",
  "project.analytics",
  "project.schedule",
  "location.contents-valuation",
  // Each of a Vendor's Mail searches in each connected mailbox.
  "vendor.mail-search",
  "meal.composition",
  "product.labels",
  "product.runs",
  "product.cookbooks",
  "product.recipe-appearances",
  "ingredient.recipe-usages",
  "cookbook.extraction-report",
  "cookbook.import-progress",
  "image.associations",
  // An Image job's attempts with their diagnostics, then its events.
  "imageJob.attempts",
  "purchase.runs",
  "location.ai-description",
  "purchase.reconciliation",
  "purchase.project-allocation",
  "purchase.financial-settlement",
  "expense.settlement",
  // A Run's detail: steps, progress, findings, transcript, log, AI usage and changes.
  "run.steps",
  "run.live-progress",
  "run.import-stats",
  "run.import-progress-live",
  "run.import-progress-stopped",
  "run.import-purchases",
  "run.import-findings",
  "run.import-targets",
  "run.import-prepared-orders",
  "run.import-timeline",
  "run.import-debug-log",
  "run.ai-usage",
  "run.suggestions",
  "run.decisions",
  "run.diagnostics",
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
  scope: reportScope,
  /** The next page of a paged report (`nextCursor` of the previous one). */
  cursor: z.string().min(1).optional(),
});
export type EntityReportInput = z.infer<typeof entityReportInput>;

/**
 * Several slots of one record in one read. The server shares declared dependencies within
 * this request while retaining requested slot order and duplicates.
 */
export const entityReportManyInput = z.object({
  slots: z.array(reportSlot).min(1).max(16),
  id: z.string().min(1),
});
export type EntityReportManyInput = z.infer<typeof entityReportManyInput>;

const reportTone = z.enum(["positive", "warning", "destructive", "muted"]);
/** Where a stage or log row stands; each client draws its own mark for each. */
const reportRowStates = [
  "done",
  "running",
  "warning",
  "failed",
  "skipped",
  "not_reached",
] as const;
export type ReportRowState = (typeof reportRowStates)[number];
const reportFormat = z.enum(["money", "count", "text"]);

/** A record a row or bar links to. */
const reportRef = z.object({
  entity: z.string().min(1),
  id: z.string(),
});

const reportProgress = z.object({
  kind: z.literal("progress"),
  label: z.string(),
  processed: z.number().nonnegative(),
  total: z.number().nonnegative().nullable(),
  summary: z.string(),
  detail: z.string(),
});

const reportStats = z.object({
  kind: z.literal("stats"),
  title: z.string().optional(),
  figures: z.array(
    z.object({
      /**
       * A stable name for a figure a client acts on rather than prints (the unscaled total
       * weight a scale anchor measures against); absent for a figure that is only read.
       */
      id: z.string().optional(),
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

/** Optional semantic presentation; `cells` remains the complete plain-text fallback. */
const reportTableCellPresentation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), state: z.enum(reportRowStates) }),
  z.object({ kind: z.literal("figure") }),
  z.object({
    kind: z.literal("links"),
    links: z.array(
      z.object({ label: z.string(), href: z.string().regex(/^\/(?!\/)/) }),
    ),
    note: z.string().optional(),
  }),
]);

const reportTable = z.object({
  kind: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(z.string()),
  /** Cells are display text composed by the server, one per column. */
  rows: z.array(
    z.object({
      id: z.string(),
      cells: z.array(z.string()),
      /** Zero-based column indexes. Readers may ignore these without losing the row's text. */
      presentation: z
        .record(z.string().regex(/^(0|[1-9]\d*)$/), reportTableCellPresentation)
        .optional(),
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

/** Ordinary commands reuse operation contracts; chunk workflows retain their bounded adapters. */
export const reportCommandRequest = z.discriminatedUnion("kind", [
  workflowCommandRequest,
  z.object({
    kind: z.literal("reprocess-cookbook"),
    cookbookId: cookbookShortcode,
  }),
  z.object({
    kind: z.literal("import-cookbook-recipes"),
    cookbookId: cookbookShortcode,
    recipeIds: z.array(z.string().min(1)).min(1),
    chunkSize: z.number().int().positive(),
  }),
]);
export type ReportCommandRequest = z.infer<typeof reportCommandRequest>;

/**
 * Something the person supplies before a command runs. The client collects it and puts it in the
 * request field of the same `key`; nothing is sent while a required input is empty. Each kind is
 * a primitive both clients already draw (a number field, the entity picker, an option list, a
 * text field).
 */
export const reportCommandInput = workflowCommandInput;
export type ReportCommandInput = z.infer<typeof reportCommandInput>;

export const reportCommand = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** The main command of its row; the rest draw as secondary. */
  prominent: z.boolean(),
  confirm: z.string().min(1).nullable(),
  /** What the person fills in first; absent for a command one tap runs. */
  inputs: z.array(reportCommandInput).optional(),
  request: reportCommandRequest,
});
export type ReportCommand = z.infer<typeof reportCommand>;

/**
 * Approve and import one prepared batch. The body is assembled from the person's answers
 * (`commitPreparedInput`): `lines` names which stable order and line each row choice decides,
 * and `tradeChoiceId` the block choice that carries the default trade (null when no line needs
 * one). A client sends nothing until every required choice is answered. Only a form's command
 * carries it, never a row's.
 */
export const commitPreparedRequest = z.object({
  kind: z.literal("commit-prepared"),
  runId: runShortcode,
  prepareOperationId: z.string().min(1),
  tradeChoiceId: z.string().min(1).nullable(),
  lines: z.array(
    z.object({
      choiceId: z.string().min(1),
      stableOrderId: z.string().min(1),
      stableLineId: z.string().min(1),
    }),
  ),
});
export type CommitPreparedRequest = z.infer<typeof commitPreparedRequest>;

/**
 * A decision the person makes on a row (or for a whole block) before a command runs. The server
 * words every label, ranks the suggestions and says what is required; nothing is preselected
 * (identity and merges are explicit), so a client starts with no answer. An answer is the chosen
 * option plus, when the option asks for them, a picked record (`pick`) and/or a reason (`text`).
 */
export const reportChoice = z.object({
  /** Unique within the report; the key an answer is stored under. */
  id: z.string().min(1),
  label: z.string().min(1),
  /** The command stays unavailable until a required choice has a complete answer. */
  required: z.boolean(),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        /** Choosing this option also picks one record of `entity` (searched by the client). */
        pick: z.object({ entity: z.string(), label: z.string() }).optional(),
        /** Choosing this option also needs a written reason. */
        text: z.object({ label: z.string() }).optional(),
        /**
         * Choosing this option also needs, for each record, a Source (`url` and `quote`) showing
         * the new record differs from it: a Distinct-from decision.
         */
        distinctFrom: z
          .array(
            z.object({ entity: z.string(), id: z.string(), name: z.string() }),
          )
          .optional(),
        /** Said once the option is chosen. */
        hint: z.string().optional(),
      }),
    )
    .min(1),
  /** Ranked records the server proposes for an option's `pick`; choosing one answers it. */
  suggestions: z
    .array(
      z.object({
        optionId: z.string().min(1),
        entity: z.string(),
        id: z.string(),
        name: z.string(),
        /** The button that chooses the suggestion ("Use X"). */
        label: z.string(),
        subtitle: z.string().optional(),
        badges: z.array(z.string()),
      }),
    )
    .optional(),
});
export type ReportChoice = z.infer<typeof reportChoice>;

/**
 * Decisions that apply to a whole `records` block and the one command they unlock. The rows'
 * own `choice`s are answered in place; `choices` here are the block's (a trade for the batch).
 */
const reportForm = z.object({
  choices: z.array(reportChoice),
  /** What running the command does, said before it is run. */
  note: z.string(),
  /** What a row choice asks for, singular ("Product decision"), for the remaining count. */
  noun: z.string(),
  /** Said when every required choice is answered. */
  completeText: z.string(),
  /** Why the command cannot run (already done, wrong state); null when it can. */
  disabledReason: z.string().nullable(),
  /** Said right after the command succeeds, before the next read reports it as done. */
  doneText: z.string(),
  command: reportCommand.extend({ request: commitPreparedRequest }),
});
export type ReportForm = z.infer<typeof reportForm>;

/** Time precision is evidence: local wall time and calendar days are never instants. */
export const reportTime = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("instant"),
    value: z.iso.datetime({ offset: true }),
  }),
  z.object({ kind: z.literal("date"), value: z.iso.date() }),
  z.object({
    kind: z.literal("local"),
    value: z.string(),
    timezone: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("unknown"),
    /** A separately labeled receipt fallback, never the event's timestamp. */
    receiptAt: z.iso.datetime({ offset: true }).optional(),
  }),
]);
export type ReportTime = z.infer<typeof reportTime>;

const reportRecordRow = z.object({
  /** The record the row opens (any entity key), or null for a row that only reads. */
  entity: z.string().nullable(),
  id: z.string().nullable(),
  title: z.string(),
  /** One short figure after the text (a count, a cost), aligned with the time. */
  trailing: z.string().nullable(),
  /** A thumbnail the row leads with. */
  imageUrl: z.string().optional(),
  /** Short chips worded by the server (a status, a failure code), toned by what they mean. */
  badges: z
    .array(z.object({ label: z.string(), tone: reportTone.optional() }))
    .optional(),
  /** An ISO instant each client prints in its own locale and zone. */
  at: z.string().optional(),
  /** Precision-aware time; when supplied, replaces the legacy instant presentation. */
  time: reportTime.optional(),
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
  /**
   * Where the row stands (a pipeline stage, a run, a log event), worded for this row ("Ran",
   * "Paused"). Clients draw `kind` as the row's mark; `badges` are only further chips.
   */
  state: z
    .object({ kind: z.enum(reportRowStates), label: z.string() })
    .optional(),
  /**
   * The row's text after its title. An untoned line is the row's result; `muted` lines are
   * evidence; `warning` and `destructive` lines wrap in full instead of clipping.
   */
  lines: z
    .array(
      z.object({
        text: z.string(),
        tone: reportTone.optional(),
        ref: reportRef.optional(),
        url: z.httpUrl().optional(),
      }),
    )
    .optional(),
  /** Raw material kept out of the way (an operation's arguments). */
  detail: z.object({ label: z.string(), text: z.string() }).optional(),
  /** An external diagnostic or reference page, opened by each client as a link. */
  externalLink: z
    .object({
      label: z.string(),
      url: z.httpUrl(),
      /** Which account or mailbox the link opens, shown on hover. */
      hint: z.string().optional(),
    })
    .optional(),
  /** Commands on this row: each runs an existing operation after its declared confirmation. */
  commands: z.array(reportCommand).optional(),
  /** A decision the person makes on this row; see `reportForm` for what it unlocks. */
  choice: reportChoice.optional(),
});
export type ReportRecordRow = z.infer<typeof reportRecordRow>;

/**
 * Rows that are records of their own (cookbooks a product is a copy of, the photos of a label, the
 * import runs of a purchase) with the verbs the slot offers. `actions` name
 * `COLLECTION_ACTION_SCOPES` verbs: web fills each in `collection-actions.tsx`, native runs the
 * plan in `nativeCollectionActionPlans`.
 */
export const reportRecordsBlock = z.object({
  /**
   * Every block lays its rows out as one aligned line each (mark or thumbnail, title, text,
   * figure and time, commands). `timeline` is for ordered stages (a pipeline, run progress) and
   * draws a rail through their states; `filmstrip` pages through photo captures.
   */
  presentation: z.enum(["filmstrip", "timeline"]).optional(),
  kind: z.literal("records"),
  /** What the block stands for, for a client that picks it out of a report (`portions:<mealRecipeId>`). */
  key: z.string().optional(),
  title: z.string().optional(),
  /** Hide secondary evidence behind a labeled disclosure, initially collapsed. */
  disclosureLabel: z.string().optional(),
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
   * `disabledReason` is shown unavailable with it. Each acts on the section's record and runs an
   * existing operation on every client that implements it; `native-coverage.ts` classifies the
   * rest.
   */
  verbs: z
    .array(
      z.object({
        id: z.enum(SECTION_ACTION_IDS),
        label: z.string(),
        scope: z.literal("section"),
        disabledReason: z.string().nullable(),
      }),
    )
    .optional(),
  /** Row choices plus the one command they unlock (approve a prepared import). */
  form: reportForm.optional(),
  /** Commands on the whole block (generate a walkthrough), each after its declared confirmation. */
  commands: z.array(reportCommand).optional(),
});

export const reportBlock = z.discriminatedUnion("kind", [
  reportProgress,
  reportStats,
  reportChart,
  reportTable,
  reportSchedule,
  reportNote,
  reportRecordsBlock,
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

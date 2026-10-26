import { humanize } from "@cubby/shared";
import { z } from "zod";
import { ledgerPartyRefOut } from "./ledger-party-fields";

import { plainDate } from "./base-entity";
import {
  dataCheck,
  dataCheckMessage,
  type DataCheck,
  dataQuality,
} from "./data-quality";
import { displayImagesField } from "./display-images";
import { shortcodeEntities } from "./entity-manifest";
import { entitySummary } from "./generated/entity-summary.gen";
import { anyShortcodeSchema } from "./identifier-fields";
import {
  ledgerPartyShortcode,
  nonEmptyTuple,
  runShortcode,
  vendorShortcode,
} from "./identifiers";
import {
  createSortParamsSchema,
  mcpPaginationFields,
  oneOrMany,
  partyFilterList,
  repositoryCurrentMember,
  presenceFilter,
} from "./pagination";
import { problemRowSchema } from "./problems";
import {
  defineSourceList,
  sourceGroupChoice,
  supportedGroupChoices,
  supportedGroupKeys,
  unsupportedGroupChoice,
} from "./source-list";

export const workQueueMemberSchema = ledgerPartyRefOut;

/** Routing reflects the evidence needed for this work, not who owns the item. */
export const workWaitingForSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("either") }),
  z.object({
    kind: z.literal("members"),
    members: z.array(workQueueMemberSchema).min(1),
  }),
  z.object({ kind: z.literal("unresolved"), reason: z.string().min(1) }),
]);

export const workQueueKindSchema = z.enum([
  "research",
  "review",
  "repair",
  "awaiting_posting",
]);
export const workQueueSourceSchema = z.enum([
  "execution",
  "research",
  "email",
  "finding",
  "reconciliation",
  "account",
  "problem",
  "suggestion",
  /** Pending statement Transaction suggestions, one row per account. */
]);

const workRecordRef = z.object({
  entity: z.enum(shortcodeEntities),
  id: anyShortcodeSchema(nonEmptyTuple(shortcodeEntities)),
});

/** One action's explanation, shared by queue, record and Run presentation.
 * Current evidence owns these values; none is a separately persisted task state. */
export const workExplanationSchema = z.object({
  key: z.string(),
  label: z.string(),
  reason: z.string(),
  category: workQueueKindSchema,
  readiness: z.enum(["ready", "blocked", "unknown"]),
  lifecycle: z.enum([
    "open",
    "running",
    "paused",
    "failed",
    "completed",
    "cancelled",
  ]),
  executor: z.enum(["automatic", "agent_session", "human", "unknown"]),
  authority: workWaitingForSchema,
  prerequisites: z.array(
    z.object({
      code: z.string(),
      state: z.enum(["satisfied", "missing", "unknown"]),
      reason: z.string(),
      record: workRecordRef.nullable(),
    }),
  ),
  effects: z.object({
    certainty: z.enum(["known", "partial", "unknown"]),
    changes: z.array(
      z.object({
        action: z.enum(["create", "link", "change", "remove"]),
        record: workRecordRef.nullable(),
        description: z.string(),
      }),
    ),
  }),
  unblocks: z.array(
    z.object({
      key: z.string(),
      record: workRecordRef.nullable(),
      reason: z.string(),
    }),
  ),
  runs: z.array(
    z.object({ id: runShortcode, relation: z.enum(["execution", "result"]) }),
  ),
});
export type WorkExplanation = z.infer<typeof workExplanationSchema>;

/** Saved views whose rows state their own data-quality gaps; the view's
 * `dataGaps` filter is the set of checks such a row can carry. */
export const workQueueGapViews = [
  { entity: "product", source: "research", view: "research-queue" },
  { entity: "vendor", source: "research", view: "research-queue" },
  { entity: "purchase", source: "research", view: "research-queue" },
  { entity: "expense", source: "research", view: "research-queue" },
  { entity: "email", source: "email", view: "pipeline-worklist" },
] as const satisfies readonly {
  entity: (typeof shortcodeEntities)[number];
  source: z.infer<typeof workQueueSourceSchema>;
  view: string;
}[];

/** The checks a gap view's rows can carry: its declared `dataGaps` filter. */
export const workQueueGapChecks = (
  gapView: (typeof workQueueGapViews)[number],
): DataCheck[] =>
  (
    entitySummary[gapView.entity].list.savedViews.find(
      (view) => view.id === gapView.view,
    )?.filters ?? []
  )
    .flatMap((filter) => (filter.id === "dataGaps" ? [filter.value] : []))
    .flat()
    .flatMap((value) => dataCheck.safeParse(value).data ?? []);

export const workQueueGapSchema = z.object({
  check: dataCheck,
  message: z.string().min(1),
});

/** Stable branch labels; dynamic counts and evidence do not become choices. */
export const workQueueReasonLabels = {
  "reconciliation:purchase-unsettled": "No settlement evidence",
  "awaiting_posting:reconciliation:purchase-unsettled":
    "Awaiting posting; no settlement evidence",
  "awaiting_posting:purchaseFinancialSettlementMismatches":
    "Awaiting posting; recorded settlement amounts differ.",
  "reconciliation:transfer":
    "Account transfer has no confirmed transfer evidence.",
  "awaiting_posting:reconciliation:transfer":
    "Awaiting posting of transfer evidence.",
  "suggestions:statement_transaction": "Transaction suggestions",
  "suggestions:recommendation": "Connection suggestions",
  "suggestions:field": "Field suggestions",
  "suggestions:transfer_pair": "Transfer suggestions",
  "image-suggestions": "Image descriptions",
  "execution:run": "Authorized execution or prerequisite wait",
  "account:run": "Run needs attention",
  finding: "Finding",
} as const;

export const workQueueReasonOptions = [
  ...[...new Set(workQueueGapViews.flatMap(workQueueGapChecks))].map(
    (check) => ({ value: check, label: dataCheckMessage[check] }),
  ),
  ...Object.entries(workQueueReasonLabels).map(([value, label]) => ({
    value,
    label,
  })),
];
const reasonKey = z
  .string()
  .min(1)
  .describe(
    "Stable Reason key: a data check, problem definition key, or branch key (for example reconciliation:purchase-unsettled, suggestions:field, finding). Awaiting-posting branches prefix awaiting_posting:.",
  );

export const workQueueVendorSchema = z.object({
  id: vendorShortcode,
  name: z.string(),
});

export const workQueueRowSchema = problemRowSchema
  .omit({
    fields: true,
    badges: true,
  })
  .extend({
    entity: problemRowSchema.shape.entity.nullable(),
    id: problemRowSchema.shape.id.nullable(),
    problemKey: z.string().min(1).optional(),
    /** One row per Suggestion family with pending Suggestions; it opens
     * the Suggestions page on that family rather than a record. */
    suggestionFamily: z
      .enum([
        "statement_transaction",
        "recommendation",
        "field",
        "transfer_pair",
      ])
      .optional(),
    key: z.string().min(1),
    source: workQueueSourceSchema,
    kind: workQueueKindSchema,
    /** Plain text; a gap row's is its gap messages as sentences. */
    reason: z.string(),
    /** Any-of memberships; a gap row carries every failing saved-view check. */
    reasonKeys: z.array(reasonKey),
    /** The saved view's checks this record currently fails; empty for rows
     * that are not data-quality gaps. */
    gaps: z.array(workQueueGapSchema),
    /** The source record's own data-quality score and status; null for rows
     * whose entity is not scored and for Problems or suggested-field rows. */
    dataQuality: dataQuality.pick({ status: true, score: true }).nullable(),
    /** The record's own money (a Purchase's SUM(Expense.cost), an Expense's
     * cost, a transaction's signed amount); null when it has none. */
    amount: z.number().nullable(),
    /** The record's own calendar day (purchase, expense, received, execution start, or
     * posted/transaction date) — never when it entered the queue, which
     * this read-time projection cannot know. */
    date: plainDate.nullable(),
    vendor: workQueueVendorSchema.nullable(),
    nextAction: z.string(),
    waitingFor: workWaitingForSchema,
    explanations: z.array(workExplanationSchema).default([]),
    /** The source record's resolved thumbnails on household reads; empty for a
     * Problems diagnostic and for every member-only read. */
    displayImages: displayImagesField,
  })
  .refine(
    (row) =>
      (row.entity !== null &&
        row.id !== null &&
        row.problemKey === undefined &&
        row.suggestionFamily === undefined) ||
      (row.entity === null &&
        row.id === null &&
        row.problemKey !== undefined &&
        row.suggestionFamily === undefined) ||
      (row.entity === null &&
        row.id === null &&
        row.problemKey === undefined &&
        row.suggestionFamily !== undefined),
    {
      message:
        "Work must name a source record, a Problems diagnostic, or a Suggestion family.",
    },
  );

export const workQueueSortableFields = [
  "name",
  "entity",
  "kind",
  "waitingFor",
  "nextAction",
  "source",
  "amount",
  "date",
  "vendor",
] as const;

export const workQueueSortSchema = createSortParamsSchema(
  workQueueSortableFields,
  "kind",
);

export const workQueuePageInput = z.strictObject({
  ...mcpPaginationFields({ defaultPageSize: 25, maxPageSize: 100 }),
  query: z.string().max(500).optional(),
  view: z.enum(["automatic", "research", "review", "waiting"]).optional(),
  kind: oneOrMany(workQueueKindSchema).optional(),
  kindExclude: oneOrMany(workQueueKindSchema).optional(),
  source: oneOrMany(workQueueSourceSchema).optional(),
  sourceExclude: oneOrMany(workQueueSourceSchema).optional(),
  reason: oneOrMany(reasonKey).optional(),
  reasonExclude: oneOrMany(reasonKey).optional(),
  vendor: oneOrMany(vendorShortcode).optional(),
  vendorExclude: oneOrMany(vendorShortcode).optional(),
  sort: workQueueSortSchema.optional(),
});

export const workQueueKindOptions = workQueueKindSchema.options.map(
  (value) => ({ value, label: humanize(value) }),
);
export const workQueueSourceOptions = workQueueSourceSchema.options.map(
  (value) => ({ value, label: humanize(value) }),
);
/** A row's record type; Problems and Suggestion family rows have none. */
export const workQueueRecordTypeOptions = shortcodeEntities.map((value) => ({
  value,
  label: entitySummary[value].singular,
}));

/**
 * The household queue's filters and Group by choices. A section's key is the
 * value its choice's filter selects, so "Filter to this" narrows the read to
 * that section; the read projects each choice's key and label.
 */
export const workQueueList = defineSourceList({
  filters: [
    { columnId: "name", field: "query", urlKey: "query", kind: "text" },
    { columnId: "view", kind: "text" },
    {
      columnId: "entity",
      kind: "multiselect",
      choices: { options: workQueueRecordTypeOptions },
      nullable: { field: "entityPresence", label: "type" },
    },
    {
      columnId: "waitingFor",
      kind: "multiselect",
      currentMember: true,
      nullable: { field: "waitingForPresence", label: "waiting for" },
    },
    {
      columnId: "source",
      kind: "multiselect",
      choices: { options: workQueueSourceOptions },
    },
    {
      columnId: "kind",
      kind: "multiselect",
      choices: { options: workQueueKindOptions },
    },
    {
      columnId: "reason",
      kind: "multiselect",
      choices: { options: workQueueReasonOptions, source: "problems" },
    },
    { columnId: "vendor", kind: "multiselect" },
  ],
  grouping: [
    sourceGroupChoice({
      key: "recordType",
      label: "Type",
      noValueLabel: "Problem",
      filter: { columnId: "entity", noValue: true },
      options: workQueueRecordTypeOptions,
    }),
    sourceGroupChoice({
      key: "waitingFor",
      label: "Waiting for",
      noValueLabel: "Unresolved",
      filter: { columnId: "waitingFor", noValue: true },
    }),
    sourceGroupChoice({
      key: "source",
      label: "Source",
      filter: { columnId: "source", noValue: false },
      options: workQueueSourceOptions,
    }),
    sourceGroupChoice({
      key: "kind",
      label: "Kind",
      filter: { columnId: "kind", noValue: false },
      options: workQueueKindOptions,
    }),
    sourceGroupChoice({
      key: "vendor",
      label: "Vendor",
      noValueLabel: "No vendor",
      filter: { columnId: "vendor", noValue: false },
    }),
    sourceGroupChoice({
      key: "nextAction",
      label: "Next action",
      filter: null,
    }),
    unsupportedGroupChoice({
      key: "reason",
      label: "Reason",
      reason:
        "A row can have several reasons, and each row belongs to one section.",
    }),
    unsupportedGroupChoice({
      key: "date",
      label: "Date",
      reason:
        "Work dates belong to different record types; sort by Date instead.",
    }),
    unsupportedGroupChoice({
      key: "amount",
      label: "Amount",
      reason: "Amounts have no sections; sort by Amount instead.",
    }),
  ],
});

/** Projected values the household queue can section by, ahead of its sort. */
export const workQueueGroupChoices = supportedGroupChoices(workQueueList);
export const workQueueGroupSchema = z
  .enum(supportedGroupKeys(workQueueList))
  .describe(
    `Unsupported: ${workQueueList.grouping
      .flatMap((choice) =>
        choice.reason === null ? [] : [`${choice.key}: ${choice.reason}`],
      )
      .join(" ")}`,
  );

/** Household UI filters select routing metadata; they confer no source access. */
export const workQueueHouseholdInput = workQueuePageInput.extend({
  /**
   * Any of: `@me` (work routed to me or Either), `either` (shared work), or a
   * member shortcode (work routed to that member).
   */
  waitingFor: partyFilterList(ledgerPartyShortcode, ["either"])
    .optional()
    .register(repositoryCurrentMember, {
      reason: "Me also matches Either work; a member code is member-only.",
    }),
  waitingForExclude: partyFilterList(ledgerPartyShortcode, ["either"])
    .optional()
    .register(repositoryCurrentMember, {
      reason: "Me also matches Either work; a member code is member-only.",
    }),
  /** `none` is Unresolved routing; `has` is resolved (members or Either). */
  waitingForPresence: presenceFilter.describe(
    "has/none waiting for, ORed with picked members",
  ),
  /** Rows about any of these record types; Problems rows have none. */
  entity: oneOrMany(z.enum(shortcodeEntities)).optional(),
  entityExclude: oneOrMany(z.enum(shortcodeEntities)).optional(),
  entityPresence: presenceFilter,
  group: workQueueGroupSchema.optional(),
});

/** Queue sections count actionable queue items, independently of entity-list memberships. */
export const workQueueGroupSummarySchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    count: z.number().int().positive(),
  })
  .meta({ id: "WorkQueueGroupSummary" });

export const workQueueOutSchema = z.object({
  items: z.array(workQueueRowSchema),
  members: z.array(workQueueMemberSchema),
  meta: z.object({
    pageIndex: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    totalCount: z.number().int().nonnegative(),
    viewCounts: z.object({
      all: z.number().int().nonnegative(),
      automatic: z.number().int().nonnegative(),
      research: z.number().int().nonnegative(),
      review: z.number().int().nonnegative(),
      waiting: z.number().int().nonnegative(),
    }),
    /** The grouped read's sections of the whole filtered set, in page order. */
    groups: z.array(workQueueGroupSummarySchema).optional(),
  }),
});

/** One record's rows of the same projection, for its detail strip. */
export const workQueueRecordInput = z.object({
  id: anyShortcodeSchema(nonEmptyTuple([...shortcodeEntities])),
});

export type WorkQueueRow = z.infer<typeof workQueueRowSchema>;
export type WorkQueueMember = z.infer<typeof workQueueMemberSchema>;
export type WorkQueueKind = z.infer<typeof workQueueKindSchema>;
export type WorkWaitingFor = z.infer<typeof workWaitingForSchema>;
export type WorkQueueGap = z.infer<typeof workQueueGapSchema>;
export type WorkQueueGroup = z.infer<typeof workQueueGroupSchema>;

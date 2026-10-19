import { z } from "zod";

import { plainDate } from "./base-entity";
import { dataCheck, type DataCheck, dataQuality } from "./data-quality";
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

export const workQueueMemberSchema = z.object({
  id: ledgerPartyShortcode,
  name: z.string(),
});

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

export const workQueuePageInput = z.object({
  ...mcpPaginationFields({ defaultPageSize: 25, maxPageSize: 100 }),
  query: z.string().max(500).optional(),
  view: z.enum(["automatic", "research", "review", "waiting"]).optional(),
  kind: oneOrMany(workQueueKindSchema).optional(),
  source: oneOrMany(workQueueSourceSchema).optional(),
  /** Gap rows failing any of these checks; every other row drops out. */
  check: oneOrMany(dataCheck).optional(),
  vendor: oneOrMany(vendorShortcode).optional(),
  sort: workQueueSortSchema.optional(),
});

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
  /** `none` is Unresolved routing; `has` is resolved (members or Either). */
  waitingForPresence: presenceFilter.describe(
    "has/none waiting for, ORed with picked members",
  ),
});

export const workQueueOutSchema = z.object({
  items: z.array(workQueueRowSchema),
  members: z.array(workQueueMemberSchema),
  meta: z.object({
    pageIndex: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    totalCount: z.number().int().nonnegative(),
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

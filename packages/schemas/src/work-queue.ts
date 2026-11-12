import { z } from "zod";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";

import { incompleteWorkDiagnosticSource } from "./work-diagnostic-facts";

import { plainDate } from "./base-entity";
import { dataCheck, dataQuality } from "./data-quality";
import { displayImagesField } from "./display-images";
import { shortcodeEntities } from "./generated/entity-roster.gen";
import { entityRoster } from "./generated/entity-roster.gen";
import { projectShortcode } from "./identifier-fields";
import { anyShortcodeSchema } from "./identifier-fields";
import { nonEmptyTuple } from "./identifiers";
import { ledgerPartyRefOut } from "./ledger-party-fields";
import {
  defineRelationList,
  relationGroupChoice,
  unsupportedGroupChoice,
} from "./relation-list";

/**
 * Who acts on a row: Cubby on its own, an agent session, a household member,
 * or something outside the household (a bank posting window, a paused Run).
 * Each work source declares it; the saved views are its values.
 */
export const workExecutor = z.enum(["automatic", "agent", "human", "external"]);
export type WorkExecutor = z.infer<typeof workExecutor>;

/**
 * What only a member may decide (ADR 0028 §1): merging or deleting a record,
 * booking money on a judgment, moving stock, contradicting what a person
 * recorded, or the member's own authority (a sign-in, a physical errand, a
 * file only they hold). Every work reason declares which one its resolution
 * takes, or null when Cubby or an agent can settle it with a reversible write.
 */
const memberDecision = z.enum([
  "merge",
  "delete",
  "money",
  "stock",
  "contradiction",
  "personal",
]);
export type MemberDecision = z.infer<typeof memberDecision>;

/** Needs you holds member decisions; everything else is the agent backlog. */
export const decisionExecutor = (
  decision: MemberDecision | null,
): Extract<WorkExecutor, "human" | "agent"> =>
  decision === null ? "agent" : "human";

/** The kind of work a source contributes; Group by Family sections by it. */
const workFamily = z.enum([
  "research",
  "email",
  "reconciliation",
  "execution",
  "account",
  "finding",
  "problem",
  "suggestion",
]);
export type WorkFamily = z.infer<typeof workFamily>;

const humanLabels = {
  automatic: "Automatic",
  agent: "Agent",
  human: "Review",
  external: "Waiting",
  research: "Research",
  email: "Email",
  reconciliation: "Reconciliation",
  execution: "Execution",
  account: "Account",
  finding: "Finding",
  problem: "Problem",
  suggestion: "Suggestion",
} as const satisfies Record<WorkExecutor | WorkFamily, string>;

const optionsOf = <const T extends readonly (keyof typeof humanLabels)[]>(
  values: T,
) => values.map((value) => ({ value, label: humanLabels[value] }));
export const workExecutorOptions = optionsOf(workExecutor.options);
export const workFamilyOptions = optionsOf(workFamily.options);
/** A row's record type; a Problems diagnostic count has none. */
export const workRecordTypeOptions = shortcodeEntities.map((value) => ({
  value,
  label: entityRoster[value].singular,
}));

/**
 * A remediation a source declares for its rows (`item`) or for its whole
 * reason group (`group`). `canonical-query` re-runs the source's query for
 * its ids; `global-backfill` is broader than the group; `guided-flow` opens
 * the owning domain's dialog.
 */
const workAction = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  scope: z.enum(["item", "group"]),
  target: z.enum(["item", "canonical-query", "global-backfill", "guided-flow"]),
  destructive: z.boolean().optional(),
});
export type WorkAction = z.infer<typeof workAction>;

/** Actions a work source declares outside Problems, whose ids are namespaced
 * by `problemActionId`; the web fills one handler for each. */
const workSourceActionIds = ["open-list", "pair-transfer"] as const;
export type WorkSourceActionId = (typeof workSourceActionIds)[number];

/** Where a row opens; route paths are client knowledge. */
const workLink = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record") }),
  /** Opens the record's pending Suggestions across every family. */
  z.object({ kind: z.literal("suggestions") }),
  /** Filters the queue to the row's reason group (a diagnostic count). */
  z.object({ kind: z.literal("reason") }),
]);
export type WorkLink = z.infer<typeof workLink>;

/** Saved views whose rows state their own data-quality gaps; the view's
 * `dataGaps` filter is the set of checks such a row can carry. */
export const workQueueGapViews = [
  { entity: "product", family: "research", view: "research-queue" },
  { entity: "vendor", family: "research", view: "research-queue" },
  { entity: "purchase", family: "research", view: "research-queue" },
  { entity: "expense", family: "research", view: "research-queue" },
  { entity: "email", family: "email", view: "pipeline-worklist" },
] as const satisfies readonly {
  entity: (typeof shortcodeEntities)[number];
  family: WorkFamily;
  view: string;
}[];

const workQueueGapSchema = z.object({
  check: dataCheck,
  message: z.string().min(1),
});

const reasonOption = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

const workQueueRowSchema = z
  .object({
    key: z.string().min(1),
    entity: z.enum(shortcodeEntities).nullable(),
    id: anyShortcodeSchema(nonEmptyTuple(shortcodeEntities)).nullable(),
    name: z.string(),
    family: workFamily,
    executor: workExecutor,
    /** Plain text; a gap row's is its gap messages as sentences. */
    reason: z.string(),
    /** Any-of memberships: data checks, problem keys, or a source's keys. */
    reasonKeys: z.array(z.string().min(1)),
    /** The members who can act; shared work lists every member. Empty is
     * unresolved routing. */
    owners: z.array(ledgerPartyRefOut),
    shared: z.boolean(),
    /** The saved view's checks this record currently fails. */
    gaps: z.array(workQueueGapSchema),
    dataQuality: dataQuality
      .pick({ status: true, score: true, gaps: true })
      .nullable(),
    /** The record's own money (a Purchase's SUM(Expense.cost)); null when
     * it has none. */
    amount: z.number().nullable(),
    /** The record's own calendar day, never when it entered the queue. */
    date: plainDate.nullable(),
    link: workLink,
    actions: z.array(workAction),
    /** Resolved thumbnails on household reads; empty on member reads. */
    displayImages: displayImagesField,
  })
  .refine((row) => (row.entity === null) === (row.id === null), {
    message: "A work row names both a record type and its id, or neither.",
  });

/**
 * The household queue: filters, sorts, Group by choices and saved views over
 * the work sources' union. Problems is the `problem` family's view.
 */
export const workQueueList = defineRelationList({
  filters: [
    {
      columnId: "entity",
      label: "Type",
      kind: "multiselect",
      options: workRecordTypeOptions,
      nullable: { label: "type" },
    },
    {
      columnId: "owner",
      label: "Owner",
      kind: "multiselect",
      column: "owner_codes",
      array: true,
      reference: "ledgerParty",
      currentMember: true,
      nullable: { label: "owner" },
    },
    {
      columnId: "family",
      label: "Family",
      kind: "multiselect",
      options: workFamilyOptions,
    },
    {
      columnId: "executor",
      label: "Executor",
      kind: "multiselect",
      options: workExecutorOptions,
    },
    {
      columnId: "reason",
      label: "Reason",
      kind: "multiselect",
      column: "reason_keys",
      array: true,
    },
  ],
  sorts: [
    { key: "executor", label: "Executor" },
    { key: "name", label: "Name" },
    { key: "entity", label: "Type" },
    { key: "family", label: "Family" },
    { key: "owner", label: "Owner", column: "owner_label" },
    { key: "amount", label: "Amount" },
    { key: "date", label: "Date" },
  ],
  defaultSort: { orderBy: "executor", direction: "asc" },
  grouping: [
    relationGroupChoice({
      key: "recordType",
      label: "Type",
      column: "entity",
      noValueLabel: "Problem",
      filter: { columnId: "entity", noValue: true },
      options: workRecordTypeOptions,
    }),
    relationGroupChoice({
      key: "owner",
      label: "Owner",
      column: "owner_key",
      noValueLabel: "Unresolved",
      filter: null,
    }),
    relationGroupChoice({
      key: "family",
      label: "Family",
      filter: { columnId: "family", noValue: false },
      options: workFamilyOptions,
    }),
    relationGroupChoice({
      key: "executor",
      label: "Executor",
      filter: { columnId: "executor", noValue: false },
      options: workExecutorOptions,
    }),
    relationGroupChoice({
      key: "reason",
      label: "Reason",
      column: "primary_reason",
      filter: { columnId: "reason", noValue: false },
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
  views: [
    {
      key: "automatic",
      label: "Automatic",
      filters: { executor: "automatic" },
    },
    // Fresh imports are where agent work pays off; newest first.
    {
      key: "agent",
      label: "Agent",
      filters: { executor: "agent" },
      sort: { orderBy: "date", direction: "desc" },
    },
    { key: "human", label: "Review", filters: { executor: "human" } },
    { key: "external", label: "Waiting", filters: { executor: "external" } },
    { key: "problems", label: "Problems", filters: { family: "problem" } },
  ],
  pageSize: { default: 25, max: 100 },
});

export const workQueueInput = workQueueList.input.extend({
  /** Zero requests full-population Reason × Type counts without record hydration. */
  pageSize: z
    .number()
    .int()
    .min(0)
    .max(workQueueList.pageSize.max)
    .default(workQueueList.pageSize.default)
    .describe(
      "Items per page; 0 returns full-filter Reason × Type counts without record rows.",
    ),
});
export const workQueueLayout = z.enum(["summary", "pivot", "table"]);
/**
 * Work that needs a member, mine plus shared: the sidebar count, the Work page
 * and Home's preview all read this one population. Optional proposals are
 * improvements a member may take up whenever they like, so they stay out.
 */
export const NEEDS_YOU_FILTERS = {
  // A filter, not the Review view: executor filters prune the sources that
  // cannot route to a member before any candidate SQL is planned.
  executor: "human" as const,
  owner: CURRENT_MEMBER_FILTER,
  reasonExclude: ["suggestions:field", "suggestions:recommendation"],
};
/** Home's preview page; the sidebar count shares this one cached read. */
export const NEEDS_YOU_INPUT = workQueueInput.parse({
  ...NEEDS_YOU_FILTERS,
  pageSize: 3,
});
/** The agent backlog's size for Work's quiet line; it never counts toward a badge. */
export const AGENT_BACKLOG_INPUT = workQueueInput.parse({
  view: "agent",
  pageSize: 0,
});
export type WorkQueueInput = z.input<typeof workQueueInput>;
export type WorkQueueView = NonNullable<
  z.output<typeof workQueueInput>["view"]
>;

/** Queue sections count actionable work, independently of entity lists. */
const workQueueGroupSummarySchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    count: z.number().int().positive(),
    /** The section's declared group actions (a reason group's bulk fixes). */
    actions: z.array(workAction),
  })
  .meta({ id: "WorkQueueGroupSummary" });

const count = z.number().int().nonnegative();

/** Each work item counts once per reason; Type margins count it only once. */
const workQueueSummarySchema = z.object({
  cells: z.array(
    z.object({
      reason: z.string().min(1),
      entity: z.enum(shortcodeEntities).nullable(),
      count,
    }),
  ),
  types: z.array(
    z.object({ entity: z.enum(shortcodeEntities).nullable(), count }),
  ),
});

export const workQueueOutSchema = z.object({
  items: z.array(workQueueRowSchema),
  meta: z.object({
    pageIndex: count,
    pageSize: count,
    summary: workQueueSummarySchema.optional(),
    /** Counts cover known candidates while Project inputs are incomplete. */
    incompleteProjectIds: z.array(projectShortcode).optional(),
    /** Missing/stale diagnostic publications; totals cover known work only. */
    incompleteDiagnosticSources: z
      .array(incompleteWorkDiagnosticSource)
      .max(64)
      .optional(),
    /** Incomplete inputs; null count means a global warning of unknown extent. */
    incompleteSources: z
      .array(
        z.object({
          source: z.string().min(1),
          label: z.string().min(1),
          count: count.nullable(),
          message: z.string().optional(),
        }),
      )
      .optional(),
    totalCount: count,
    viewCounts: z.record(z.string(), count),
    /** The grouped read's sections of the whole filtered set, in page order. */
    groups: z.array(workQueueGroupSummarySchema).optional(),
    /** Every composed source's declared reasons, for the Reason filter. */
    reasons: z.array(reasonOption),
    /**
     * A published read's snapshot instant, and the raw error when the latest
     * republish failed (its rows are still the last good publication). Live
     * reads omit it.
     */
    publication: z
      .object({ publishedAt: z.string(), error: z.string().nullable() })
      .optional(),
  }),
});

/** One record's rows of the same projection, for its detail strip. */
export const workQueueRecordInput = z.object({
  id: anyShortcodeSchema(nonEmptyTuple([...shortcodeEntities])),
});

export type WorkQueueRow = z.infer<typeof workQueueRowSchema>;
export type WorkQueueGap = z.infer<typeof workQueueGapSchema>;
export type WorkQueueOut = z.infer<typeof workQueueOutSchema>;

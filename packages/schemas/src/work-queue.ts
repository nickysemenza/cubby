import { z } from "zod";

import { plainDate } from "./base-entity";
import { dataCheck, type DataCheck, dataQuality } from "./data-quality";
import { displayImagesField } from "./display-images";
import { shortcodeEntities } from "./entity-manifest";
import { entitySummary } from "./generated/entity-summary.gen";
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

/** The kind of work a source contributes; Group by Family sections by it. */
export const workFamily = z.enum([
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
  label: entitySummary[value].singular,
}));

/**
 * A remediation a source declares for its rows (`item`) or for its whole
 * reason group (`group`). `canonical-query` re-runs the source's query for
 * its ids; `global-backfill` is broader than the group; `guided-flow` opens
 * the owning domain's dialog.
 */
export const workAction = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  scope: z.enum(["item", "group"]),
  target: z.enum(["item", "canonical-query", "global-backfill", "guided-flow"]),
  destructive: z.boolean().optional(),
});
export type WorkAction = z.infer<typeof workAction>;

/** Where a row opens; route paths are client knowledge. */
export const workLink = z.discriminatedUnion("kind", [
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

const reasonOption = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

export const workQueueRowSchema = z
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
    dataQuality: dataQuality.pick({ status: true, score: true }).nullable(),
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
    { key: "agent", label: "Agent", filters: { executor: "agent" } },
    { key: "human", label: "Review", filters: { executor: "human" } },
    { key: "external", label: "Waiting", filters: { executor: "external" } },
    { key: "problems", label: "Problems", filters: { family: "problem" } },
  ],
  pageSize: { default: 25, max: 100 },
});

export const workQueueInput = workQueueList.input;
export type WorkQueueInput = z.input<typeof workQueueInput>;
export type WorkQueueView = NonNullable<
  z.output<typeof workQueueInput>["view"]
>;

/** Queue sections count actionable work, independently of entity lists. */
export const workQueueGroupSummarySchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    count: z.number().int().positive(),
    /** The section's declared group actions (a reason group's bulk fixes). */
    actions: z.array(workAction),
  })
  .meta({ id: "WorkQueueGroupSummary" });

const count = z.number().int().nonnegative();

export const workQueueOutSchema = z.object({
  items: z.array(workQueueRowSchema),
  meta: z.object({
    pageIndex: count,
    pageSize: z.number().int().positive(),
    totalCount: count,
    viewCounts: z.record(z.string(), count),
    /** The grouped read's sections of the whole filtered set, in page order. */
    groups: z.array(workQueueGroupSummarySchema).optional(),
    /** Every composed source's declared reasons, for the Reason filter. */
    reasons: z.array(reasonOption),
  }),
});

/** One record's rows of the same projection, for its detail strip. */
export const workQueueRecordInput = z.object({
  id: anyShortcodeSchema(nonEmptyTuple([...shortcodeEntities])),
});

export type WorkQueueRow = z.infer<typeof workQueueRowSchema>;
export type WorkQueueGap = z.infer<typeof workQueueGapSchema>;
export type WorkQueueOut = z.infer<typeof workQueueOutSchema>;

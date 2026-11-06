import { suggestionStatus } from "@cubby/schemas/ai";
import {
  type DataCheck,
  dataCheckKind,
  dataCheckPresentation,
  dataChecksByEntity,
} from "@cubby/schemas/data-quality";
import {
  type connectionEvidence,
  type ConnectionProposal,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { entityRoster } from "@cubby/schemas/entity-roster";
import type {
  StatementSuggestionOut,
  StatementTransactionAction,
  StatementTransactionApplication,
} from "@cubby/schemas/statement-suggestion";
import {
  suggestionFamily,
  type suggestionReviewInput,
} from "@cubby/schemas/suggestion";
import {
  type SuggestionColumnValue,
  type SuggestionCountsOut,
  type SuggestionImpact,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListRow,
  type SuggestionRecordRef,
  type SuggestionStrength,
  type suggestionAction,
} from "@cubby/schemas/suggestion-list";
import { transferPairJudgment } from "@cubby/schemas/transfer-pair-suggestion";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import {
  currentTransferPairs,
  transferPairEvidenceFingerprint,
  transferPairStateData,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import { type StatementSuggestionScope } from "~/server/domains/transaction-import/repo/statement-suggestion-read";
import { suggestionCounts } from "~/server/generic/suggestions/repo/suggestion-review";

type ShortcodeEntity = SuggestionRecordRef["entity"];

/**
 * One Suggestion's list facts, read for every row in scope before any row is
 * hydrated: Strength, clean, Impact and its family's declared relation columns.
 */
export type SuggestionKey = {
  family: SuggestionListFamily;
  suggestionId: string;
  status: z.infer<typeof suggestionStatus>;
  fingerprint: string | null;
  clean: boolean;
  strength: SuggestionStrength;
  impact: SuggestionImpact[];
  createdAt: Date;
  columns: Record<string, SuggestionColumnValue | SuggestionColumnValue[]>;
  matchedRules: string[];
  automaticRule: string | null;
};

export const stamps = z.array(z.string()).catch([]);

/** `records` is set when the caller filters by recordIds (resolved, maybe empty). */
export type SuggestionFamilyQuery = {
  filters: SuggestionListFilters;
  records?: { code: string; entity: ShortcodeEntity; id: string }[];
  suggestionIds?: readonly string[];
};

/** Push declared secondary-record matches into each family's indexed key read. */
export const suggestionIdScope = (
  ids: readonly string[] | undefined,
  column: SQL,
) => (ids ? sql`${column} = ANY(${uuidArrayParam(ids)})` : sql`true`);

export type SuggestionPendingCounts = Pick<
  SuggestionCountsOut["families"][number],
  "pending" | "clean" | "strong" | "medium" | "weak"
>;

export const emptyPendingCounts = (): SuggestionPendingCounts => ({
  pending: 0,
  clean: 0,
  strong: 0,
  medium: 0,
  weak: 0,
});

type ReviewItem = z.input<typeof suggestionReviewInput>;
type Action = z.infer<typeof suggestionAction>;
type RowOf<F extends SuggestionListFamily> = Extract<
  SuggestionListRow,
  { family: F }
>;

/** One family's browse columns; names match the declared filters and sorts. */
export type SuggestionFactQuery = {
  columns: Partial<Record<string, SQL>>;
  from: SQL;
  where: SQL;
};

type SuggestionOutcomes = {
  applied: number;
  rejected: number;
  superseded: number;
  resolved: number;
  fields: Awaited<ReturnType<typeof suggestionCounts>>;
};

/**
 * Presentation for one Suggestion family. Candidate matching, freshness
 * rechecks and apply authority stay with the family's review handler in
 * `suggestion-review.ts`; this adds listing, Strength, Impact and clean.
 */
export type SuggestionFamilyPresentation<F extends SuggestionListFamily> = {
  /**
   * Browse columns for a family too large to read as keys. Only columns named
   * in `needs` have to be meaningful; rows are revalidated when paged in.
   */
  facts?: (
    query: SuggestionFamilyQuery,
    needs: ReadonlySet<string>,
  ) => SuggestionFactQuery | null;
  keys: (
    db: Database,
    query: SuggestionFamilyQuery,
  ) => Promise<SuggestionKey[]>;
  /** Current rows by Suggestion id; a key whose evidence went stale is absent. */
  rows: (
    db: Database,
    keys: readonly SuggestionKey[],
  ) => Promise<Map<string, RowOf<F>>>;
  outcomes: (
    db: Database,
    filters: SuggestionListFilters,
  ) => Promise<SuggestionOutcomes>;
  /** The review item that accepts a clean row exactly as recommended. */
  acceptAsIs: (row: RowOf<F>) => ReviewItem | null;
};

export const verbs = (...list: Action["verb"][]): Action[] =>
  list.map((verb) => ({ verb, ownerOnly: false }));

export const qualityImpact = (check: DataCheck): SuggestionImpact => ({
  kind: "quality_check",
  label: dataCheckPresentation[check].satisfiedLabel,
  qualityCheck: check,
});
export const outcome = (label: string): SuggestionImpact => ({
  kind: "resolves",
  label,
});

export const keyBase = (key: SuggestionKey) => ({
  id: key.suggestionId,
  suggestionId: key.suggestionId,
  fingerprint: key.fingerprint,
  strength: key.strength,
  clean: key.clean,
  impact: key.impact,
  matchedRules: key.matchedRules,
  automaticRule: key.automaticRule,
  createdAt: key.createdAt.toISOString(),
  columns: key.columns,
});

const recordIdsOf = (
  query: SuggestionFamilyQuery,
  entities: readonly ShortcodeEntity[],
) =>
  query.records
    ?.filter((record) => entities.includes(record.entity))
    .map((record) => record.id);

export const runCode = (query: SuggestionFamilyQuery) => query.filters.runId;

// ---------------------------------------------------------------- field

export const fieldChecks = new Map<string, DataCheck[]>();
for (const [entity, checks] of Object.entries(dataChecksByEntity))
  for (const check of checks.options) {
    const placement = dataCheckPresentation[check].placement;
    if (
      dataCheckKind[check] === "defect" ||
      placement === null ||
      !("field" in placement)
    )
      continue;
    const key = `${entity}.${placement.field}`;
    fieldChecks.set(key, [...(fieldChecks.get(key) ?? []), check]);
  }

/**
 * A field Suggestion's only evidence is the decision model's confidence, and
 * confidence alone never makes a Suggestion strong or clean (terminology:
 * Strength; ADR 0016 amendment). Its Automatic rule, not bulk accept, is
 * what may apply a confident Addition unattended.
 */
export const fieldStrength = (confidence: number): SuggestionStrength =>
  confidence >= 0.85 ? "medium" : "weak";

export const shortcodeEntity = z.enum(shortcodeEntities);
export const fieldKind = z.enum(["correction", "addition"]);

// ---------------------------------------------------- statement_transaction

export const statementImpact = {
  // No data-quality check closes: the outcome is the unmatched charge.
  create: [
    outcome("Statement charge matched"),
    {
      kind: "caution",
      label: "The new transaction may open its own data-quality checks",
    },
  ],
  attach: [outcome("Statement charge matched")],
  supersede: [
    outcome("Statement charge matched"),
    outcome("Pending hold retired"),
  ],
  void: [outcome("Statement charge matched"), outcome("Hold voided")],
  book: [outcome("Spending booked")],
} satisfies Record<StatementTransactionAction, SuggestionImpact[]>;

export const statementStrength = (key: {
  clean: boolean;
  labelSame: string | null;
  labelConfidence: string | null;
}): SuggestionStrength =>
  key.clean || (key.labelSame === "same" && key.labelConfidence === "high")
    ? "strong"
    : key.labelConfidence === "medium"
      ? "medium"
      : "weak";

export const otherTransaction = (row: StatementSuggestionOut) => {
  if (row.matchedTransactionId) return row.matchedTransactionId;
  if (row.recommended === "attach" && row.candidates[0])
    return row.candidates[0].transactionId;
  if (row.recommended === "supersede" && row.supersedeTransactionId)
    return row.supersedeTransactionId;
  if (row.recommended === "void" && row.voidTransactionId)
    return row.voidTransactionId;
  return null;
};

/** Accept as is: the recommended action; an attach always names its candidate. */
export function statementAcceptApplication(
  row: StatementSuggestionOut,
): StatementTransactionApplication | null {
  const target = row.candidates[0]?.transactionId;
  if (row.recommended === "attach" && !target) return null;
  return {
    kind: "statement_transaction",
    action: row.recommended,
    ...(row.recommended === "attach" ? { transactionId: target } : {}),
    fields: [],
    // The server refuses a create while any candidate is still live.
    rejectedCandidateIds:
      row.recommended === "create"
        ? row.candidates.map((candidate) => candidate.transactionId)
        : [],
  };
}

const owesFamily = (entity: ShortcodeEntity, family: SuggestionListFamily) =>
  entityRoster[entity].suggestionFamilies.some((owed) => owed === family);
const entitiesOwing = (family: SuggestionListFamily) =>
  shortcodeEntities.filter((entity) => owesFamily(entity, family));
const STATEMENT_ENTITIES = entitiesOwing("statement_transaction");
const TRANSFER_ENTITIES = entitiesOwing("transfer_pair");

export function statementScope(
  query: SuggestionFamilyQuery,
): StatementSuggestionScope | null {
  const { filters } = query;
  const status = filters.status;
  if (status !== "pending" && status !== "applied") return null;
  if (
    filters.recordEntity &&
    !STATEMENT_ENTITIES.includes(filters.recordEntity)
  )
    return null;
  const recordUuids = recordIdsOf(query, STATEMENT_ENTITIES);
  if (recordUuids?.length === 0) return null;
  return {
    recordUuids,
    runCode: runCode(query),
    status,
    suggestionIds: query.suggestionIds,
  };
}

// ------------------------------------------------------------ recommendation

export const connectionImpact = {
  "product-purchase": [qualityImpact("product_unpurchased")],
  "product-expense": [
    qualityImpact("product_unpurchased"),
    qualityImpact("expense_product_resolution"),
  ],
  "product-identity": [outcome("Duplicate Products merged")],
  "email-purchase": [outcome("Order Email linked")],
  "transaction-purchase": [
    qualityImpact("settlement_reference"),
    qualityImpact("financial_transaction_allocation"),
  ],
  "transaction-transfer": [outcome("Transfer paired")],
  "transaction-refund": [qualityImpact("financial_transaction_allocation")],
  "expense-project": [outcome("Project assigned")],
  "project-tool": [outcome("Tool use recorded")],
  "task-subject-product": [outcome("Task subject recorded")],
  "product-ingredient": [qualityImpact("ingredient_product")],
  "product-grows-plant": [outcome("Plant recorded")],
  "cookbook-product": [outcome("Cookbook Product recorded")],
  "device-product": [outcome("Device Product recorded")],
  "inventory-location": [qualityImpact("inventory_unknown_location")],
} satisfies Record<ConnectionRelation, SuggestionImpact[]>;

// Acquisition discovery's indexed lexical/semantic retrieval; every other
// candidate comes from deterministic record evidence.
export const RETRIEVED_REASON = "Retrieved from ";

export const connectionStrength = (
  evidence: z.infer<typeof connectionEvidence>,
): SuggestionStrength => {
  const retrieved = evidence.reasons.some((reason) =>
    reason.startsWith(RETRIEVED_REASON),
  );
  const contradicted = evidence.contradictions.length > 0;
  return retrieved
    ? contradicted
      ? "weak"
      : "medium"
    : contradicted
      ? "medium"
      : "strong";
};

export const connectionActions = (proposal: ConnectionProposal): Action[] => {
  if (proposal.integration.kind === "product-pair-review") return [];
  const ownerOnly =
    proposal.relation === "email-purchase" ||
    proposal.integration.kind === "email-link-review";
  return [
    { verb: "accept", ownerOnly },
    ...verbs("reject", "dismiss", "never_suggest"),
  ];
};

export const connectionImpactCount = sql.join(
  Object.entries(connectionImpact).map(
    ([relation, impacts]) =>
      sql`WHEN ${`connection.${relation}`} THEN ${impacts.filter((impact) => "qualityCheck" in impact).length}::int`,
  ),
  sql` `,
);

export async function transferPairRows(
  db: Database,
  query: SuggestionFamilyQuery,
  ids?: readonly string[],
) {
  if (
    query.filters.recordEntity &&
    !TRANSFER_ENTITIES.includes(query.filters.recordEntity)
  )
    return [];
  if (
    query.records &&
    !query.records.some((record) => TRANSFER_ENTITIES.includes(record.entity))
  )
    return [];
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    createdAt: Date | string;
    judgment: unknown;
    data: unknown;
  }>(sql`
    SELECT s.id, s.fingerprint, s."createdAt", s.judgment, s.data
    FROM "Suggestion" s
    WHERE s.family = ${suggestionFamily.enum.transfer_pair} AND s.status = ${query.filters.status}
      AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
      ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}
      ${query.filters.status === "pending" ? sql`AND s.active` : sql``}
      ${runCode(query) ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runCode(query)})` : sql``}
  `);
  if (!rows.length) return [];
  // Browse pages list stored pairs; apply rechecks the evidence with its fence.
  const current =
    query.filters.status === "pending" && !ids && !query.suggestionIds
      ? new Map(
          await Promise.all(
            (
              await currentTransferPairs(
                db,
                rows.map(
                  (row) => transferPairStateData.parse(row.data).pairKey,
                ),
              )
            ).map(
              async (pair) =>
                [
                  pair.key,
                  await transferPairEvidenceFingerprint(pair),
                ] as const,
            ),
          ),
        )
      : null;
  return rows.flatMap((row) => {
    const evidence = transferPairJudgment.parse(row.judgment);
    if (
      current &&
      current.get(evidence.key) !==
        transferPairStateData.parse(row.data).evidenceFingerprint
    )
      return [];
    const records = [
      { entity: "financialAccount", id: evidence.outflow.accountId },
      { entity: "financialAccount", id: evidence.inflow.accountId },
      ...(evidence.outflow.transactionId
        ? [
            {
              entity: "financialTransaction",
              id: evidence.outflow.transactionId,
            },
          ]
        : []),
      ...(evidence.inflow.transactionId
        ? [
            {
              entity: "financialTransaction",
              id: evidence.inflow.transactionId,
            },
          ]
        : []),
      ...(evidence.outflow.owner
        ? [{ entity: "ledgerParty", id: evidence.outflow.owner.id }]
        : []),
      ...(evidence.inflow.owner
        ? [{ entity: "ledgerParty", id: evidence.inflow.owner.id }]
        : []),
    ];
    if (
      query.filters.recordEntity &&
      !records.some((record) => record.entity === query.filters.recordEntity)
    )
      return [];
    if (
      query.records &&
      !query.records.some((record) =>
        records.some(
          (ref) => ref.entity === record.entity && ref.id === record.code,
        ),
      )
    )
      return [];
    return [{ ...row, evidence, createdAt: new Date(row.createdAt) }];
  });
}

export const TRANSFER_WEAK_BLOCKERS = [
  "weak_movement",
  "competing_candidates",
  "unresolved_overlap",
  "cash_leg_missing",
  "owner_missing",
];

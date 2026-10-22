import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  type assessmentReviewInput,
  feedbackAuthority,
  feedbackVerdict,
} from "@cubby/schemas/assessment";
import {
  type DataCheck,
  dataCheckKind,
  dataCheckPresentation,
  dataChecksByEntity,
} from "@cubby/schemas/data-quality";
import {
  connectionCandidate,
  type connectionEvidence,
  type ConnectionProposal,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import type {
  StatementSuggestionOut,
  StatementTransactionAction,
  StatementTransactionApplication,
} from "@cubby/schemas/statement-suggestion";
import {
  fieldSuggestionRow,
  recommendationSuggestionRow,
  statementSuggestionRow,
  transferPairSuggestionRow,
  type SuggestionColumnValue,
  type SuggestionImpact,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListRow,
  type SuggestionRecordRef,
  type SuggestionStrength,
  type SuggestionSummaryPart,
  type suggestionAction,
} from "@cubby/schemas/suggestion-list";
import { transferPairJudgment } from "@cubby/schemas/transfer-pair-suggestion";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { readEntityConnectionsBatch } from "~/server/domains/connection/repo/entity-connections";
import {
  currentTransferPairs,
  transferPairEvidenceFingerprint,
  transferPairStateData,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import {
  readStatementSuggestions,
  statementSuggestionKeys,
  statementSuggestionStatusCounts,
} from "~/server/domains/transaction-import/repo/statement-suggestion-read";
import { kindAgreed } from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import { reviewFamilyDeclarations } from "~/server/generic/assessment/repo/review-families";
import {
  fieldSuggestionKeys,
  readFieldSuggestions,
  suggestionCounts,
} from "~/server/generic/assessment/repo/suggestion-review";

import {
  productPairFamily,
  imageDescriptionFamily,
} from "./stored-suggestion-families";
import { tagSuggestionKeys, tagSuggestionRows } from "./tag-suggestions";

type ShortcodeEntity = SuggestionRecordRef["entity"];
type Columns = Record<string, SuggestionColumnValue | SuggestionColumnValue[]>;

/**
 * One Suggestion's list facts, read for every row in scope before any row is
 * hydrated: Strength, clean, Impact and its family's `suggestionColumns`.
 */
export type SuggestionKey = {
  family: SuggestionListFamily;
  assessmentId: string;
  status: SuggestionListFilters["status"];
  fingerprint: string | null;
  clean: boolean;
  strength: SuggestionStrength;
  impact: SuggestionImpact[];
  createdAt: Date;
  columns: Columns;
  /** Rule stamps matched at publication. */
  matchedRules: string[];
  /** `<ruleKey>@<revision>` when an Automatic rule applied it. */
  automaticRule: string | null;
};

const stamps = z.array(z.string()).catch([]);

/** `records` is set when the caller filters by recordIds (resolved, maybe empty). */
export type SuggestionFamilyQuery = {
  filters: SuggestionListFilters;
  records?: { code: string; entity: ShortcodeEntity; id: string }[];
  assessmentIds?: readonly string[];
};

/** Push declared secondary-record matches into each family's indexed key read. */
export const assessmentIdScope = (
  ids: readonly string[] | undefined,
  column: SQL,
) => (ids ? sql`${column} = ANY(${uuidArrayParam(ids)})` : sql`true`);

type ReviewItem = z.input<typeof assessmentReviewInput>;
type Action = z.infer<typeof suggestionAction>;
type RowOf<F extends SuggestionListFamily> = Extract<
  SuggestionListRow,
  { family: F }
>;

type SuggestionOutcomes = {
  applied: number;
  rejected: number;
  superseded: number;
  resolved: number;
  fields: Awaited<ReturnType<typeof suggestionCounts>>;
};

/**
 * Presentation for one Assessment family. Candidate matching, freshness
 * rechecks and apply authority stay with the family's review handler in
 * `assessment-review.ts`; this adds listing, Strength, Impact and clean.
 */
export type SuggestionFamilyPresentation<F extends SuggestionListFamily> = {
  keys: (
    db: Database,
    query: SuggestionFamilyQuery,
  ) => Promise<SuggestionKey[]>;
  /** Current rows by Assessment id; a key whose evidence went stale is absent. */
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

const verbs = (...list: Action["verb"][]): Action[] =>
  list.map((verb) => ({ verb, ownerOnly: false }));

const qualityImpact = (check: DataCheck): SuggestionImpact => ({
  kind: "quality_check",
  label: dataCheckPresentation[check].satisfiedLabel,
  qualityCheck: check,
});
const outcome = (label: string): SuggestionImpact => ({
  kind: "resolves",
  label,
});

export const keyBase = (key: SuggestionKey) => ({
  id: key.assessmentId,
  assessmentId: key.assessmentId,
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

const runCode = (query: SuggestionFamilyQuery) => query.filters.runId;

// ---------------------------------------------------------------- field

const fieldChecks = new Map<string, DataCheck[]>();
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
const fieldStrength = (confidence: number): SuggestionStrength =>
  confidence >= 0.85 ? "medium" : "weak";

const shortcodeEntity = z.enum(shortcodeEntities);
const fieldKind = z.enum(["correction", "addition"]);

const field: SuggestionFamilyPresentation<"field"> = {
  keys: async (db, query) => {
    const { filters, records } = query;
    // Pushed into SQL: the record roster, entity and Run. Column filters
    // apply to every family's keys in the generic list.
    const rows = await fieldSuggestionKeys(db, {
      status: filters.status,
      entities: filters.entity ? [filters.entity] : undefined,
      recordUuids: records?.map((record) => record.id),
      runId: runCode(query),
      assessmentIds: query.assessmentIds,
    });
    return rows.map((row) => {
      const entity = shortcodeEntity.parse(row.entity);
      const kind = fieldKind.parse(row.kind);
      const strength = fieldStrength(row.confidence);
      return {
        family: "field" as const,
        assessmentId: row.id,
        status: filters.status,
        matchedRules: stamps.parse(row.matchedRules),
        automaticRule: row.automaticRule,
        fingerprint: row.fingerprint,
        strength,
        clean: false,
        impact:
          kind === "addition"
            ? (fieldChecks.get(`${entity}.${row.field}`) ?? []).map(
                qualityImpact,
              )
            : [],
        createdAt: row.createdAt,
        columns: {
          entity,
          field: row.field,
          kind,
          confidence: row.confidence,
        },
      };
    });
  },
  rows: async (db, keys) => {
    const rows = await readFieldSuggestions(
      db,
      keys.map((key) => key.assessmentId),
    );
    const byId = new Map(keys.map((key) => [key.assessmentId, key]));
    return new Map(
      rows.flatMap((row) => {
        const key = byId.get(row.assessmentId);
        if (!key) return [];
        const summary: SuggestionSummaryPart[] = [
          { kind: "field", entity: row.entity, field: row.field },
          ...(row.kind === "correction"
            ? [{ kind: "value" as const, value: row.currentValue }]
            : []),
          { kind: "value", value: row.suggestedValue },
        ];
        return [
          [
            row.assessmentId,
            fieldSuggestionRow.parse({
              ...keyBase(key),
              family: "field",
              record: { entity: row.entity, id: row.recordId },
              summary,
              actions: verbs("accept", "correct", "reject", "dismiss"),
              evidence: row,
            }),
          ],
        ];
      }),
    );
  },
  outcomes: async (db, filters) => {
    const fields = await suggestionCounts(db, {
      runId: filters.runId,
      entity: filters.entity,
    });
    const sum = (key: "applied" | "rejected" | "superseded" | "resolved") =>
      fields.reduce((total, row) => total + row[key], 0);
    return {
      applied: sum("applied"),
      rejected: sum("rejected"),
      superseded: sum("superseded"),
      resolved: sum("resolved"),
      fields,
    };
  },
  acceptAsIs: (row) => ({
    assessmentId: row.assessmentId,
    operationId: crypto.randomUUID(),
    verdict: "correct",
    correction: { present: false },
    intent: "apply",
    expectedFingerprint: row.fingerprint,
    reason: null,
    evidence: null,
  }),
};

// ---------------------------------------------------- statement_transaction

const statementImpact = {
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

const statementStrength = (key: {
  clean: boolean;
  labelSame: string | null;
  labelConfidence: string | null;
}): SuggestionStrength =>
  key.clean || (key.labelSame === "same" && key.labelConfidence === "high")
    ? "strong"
    : key.labelConfidence === "medium"
      ? "medium"
      : "weak";

const otherTransaction = (row: StatementSuggestionOut) => {
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
function statementAcceptApplication(
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

const STATEMENT_ENTITIES: readonly ShortcodeEntity[] = [
  "financialAccount",
  "financialTransaction",
  "purchase",
  "expense",
  "vendor",
  "spendingCategory",
  "ledgerParty",
];

const statementTransaction: SuggestionFamilyPresentation<"statement_transaction"> =
  {
    keys: async (db, query) => {
      const { filters } = query;
      const status = filters.status;
      if (status !== "pending" && status !== "applied") return [];
      if (filters.entity && !STATEMENT_ENTITIES.includes(filters.entity))
        return [];
      const recordUuids = recordIdsOf(query, STATEMENT_ENTITIES);
      if (recordUuids?.length === 0) return [];
      const rows = await statementSuggestionKeys(db, {
        recordUuids,
        runCode: runCode(query),
        status,
        assessmentIds: query.assessmentIds,
      });
      return rows.map((row) => ({
        family: "statement_transaction" as const,
        assessmentId: row.id,
        status,
        matchedRules: stamps.parse(row.matchedRules),
        automaticRule: row.automaticRule,
        fingerprint: row.fingerprint,
        clean: row.clean,
        strength: statementStrength(row),
        impact: row.reviewReason
          ? [{ kind: "caution", label: row.reviewReason }]
          : statementImpact[row.recommended],
        createdAt: row.createdAt,
        columns: {
          date: row.statementDate,
          month: row.statementDate.slice(0, 7),
          account: row.accountCode,
          owner: row.ownerCode,
          merchant: [row.merchant, row.rawDescription]
            .filter(Boolean)
            .join(" "),
          amount: row.amount,
          action: row.recommended,
          kind: row.kind,
          kindSource: row.kindSource,
          providerCategory: row.sourceCategory,
          providerStatus: row.providerStatus,
          candidate: row.candidateCode,
          modelLabel:
            row.labelSame && row.labelConfidence
              ? `${row.labelSame}:${row.labelConfidence}`
              : null,
        },
      }));
    },
    rows: async (db, keys) => {
      const rows = await readStatementSuggestions(
        db,
        keys.map((key) => key.assessmentId),
        keys[0]?.status === "applied" ? "applied" : "pending",
      );
      const byId = new Map(keys.map((key) => [key.assessmentId, key]));
      return new Map(
        rows.flatMap((row) => {
          const key = byId.get(row.assessmentId);
          if (!key) return [];
          const other = otherTransaction(row);
          return [
            [
              row.assessmentId,
              statementSuggestionRow.parse({
                ...keyBase(key),
                fingerprint: row.fingerprint,
                family: "statement_transaction",
                record: { entity: "financialAccount", id: row.accountId },
                ...(other
                  ? { other: { entity: "financialTransaction", id: other } }
                  : {}),
                summary: [
                  { kind: "amount", amount: row.amount },
                  { kind: "date", date: row.statementDate },
                  { kind: "text", text: row.merchant ?? row.rawDescription },
                ],
                // Dismissal suppresses the charge permanently.
                actions: row.reviewReason
                  ? verbs("dismiss")
                  : verbs("accept", "correct", "dismiss"),
                evidence: row,
              }),
            ],
          ];
        }),
      );
    },
    outcomes: async (db, filters) => {
      const rows = await statementSuggestionStatusCounts(db, filters.runId);
      const of = (status: string) =>
        rows.find((row) => row.status === status)?.count ?? 0;
      return {
        applied: of("applied"),
        rejected: of("rejected"),
        superseded: of("superseded"),
        resolved: of("resolved"),
        fields: [],
      };
    },
    acceptAsIs: (row) => {
      // Labels ride on top of the evidence fingerprint, so a create labelled
      // clean under an earlier rule still passes the apply-time check.
      // Accept clean re-reads today's rule instead of the stored flag.
      if (row.evidence.reviewReason) return null;
      const { recommended, create, transfer, transferPair } = row.evidence;
      if (
        recommended === "create" &&
        create &&
        !kindAgreed(create, transfer, transferPair)
      )
        return null;
      const application = statementAcceptApplication(row.evidence);
      return application
        ? {
            assessmentId: row.assessmentId,
            operationId: crypto.randomUUID(),
            verdict: "correct",
            correction: { present: false },
            intent: "apply",
            expectedFingerprint: row.fingerprint,
            reason: null,
            evidence: null,
            application,
          }
        : null;
    },
  };

// ------------------------------------------------------------ recommendation

const connectionImpact = {
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
const RETRIEVED_REASON = "Retrieved from ";

const connectionStrength = (
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

const connectionActions = (proposal: ConnectionProposal): Action[] => {
  if (proposal.integration.kind === "product-pair-review") return [];
  const ownerOnly =
    proposal.relation === "email-purchase" ||
    proposal.integration.kind === "email-link-review";
  return [
    { verb: "accept", ownerOnly },
    ...verbs("reject", "dismiss", "never_suggest"),
  ];
};

const READ_BATCH = 250;

const recommendation: SuggestionFamilyPresentation<"recommendation"> = {
  keys: async (db, query) => {
    const { filters, records } = query;
    if (filters.status !== "pending") return [];
    if (records?.length === 0) return [];
    const side = (end: "source" | "target", key: "entityKind" | "entityId") =>
      sql`(a.evidence->'candidate'->${end}->>${key})`;
    const endpoint = (end: "source" | "target") =>
      sql`${side(end, "entityKind")} || ':' || ${side(end, "entityId")}`;
    const roster = records
      ? sql.join(
          records.map((record) => sql`${`${record.entity}:${record.code}`}`),
          sql`, `,
        )
      : null;
    const run = runCode(query);
    // Mirrors readEntityConnectionsBatch's selection; hydration rechecks evidence.
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      fingerprint: string | null;
      createdAt: Date | string;
      candidate: unknown;
    }>(sql`
      SELECT a.id, a.fingerprint, a."createdAt", a.evidence->'candidate' AS candidate
      FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
      WHERE a.family = ${assessmentFamily.enum.recommendation} AND a.served AND s.active
        AND ${assessmentIdScope(query.assessmentIds, sql`a.id`)}
        AND s.status = ${suggestionStatus.enum.pending}
        AND ${reviewFamilyDeclarations.recommendation.scopes.connection}
        AND NOT EXISTS (SELECT 1 FROM "Feedback" f WHERE f."assessmentId" = a.id
          AND f.authority = ${feedbackAuthority.enum.member}
          AND f.verdict IN (${feedbackVerdict.enum.wrong}, ${feedbackVerdict.enum.dismissed}))
        AND NOT EXISTS (SELECT 1 FROM "AssessmentState" suppressed WHERE suppressed.active
          AND suppressed.entity = s.entity AND suppressed."recordId" = s."recordId"
          AND suppressed.suppression->>'scope' = a.subject->>'scope'
          AND suppressed.suppression->>'candidateKey' = a.subject->>'candidateKey'
          AND (suppressed.suppression->>'fingerprint' IS NULL OR suppressed.suppression->>'fingerprint' = a.fingerprint))
        ${roster ? sql`AND (${endpoint("source")} IN (${roster}) OR ${endpoint("target")} IN (${roster}))` : sql``}
        ${filters.entity ? sql`AND (${side("source", "entityKind")} = ${filters.entity} OR ${side("target", "entityKind")} = ${filters.entity})` : sql``}
        ${run ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${run})` : sql``}
    `);
    const connectionKeys = rows.flatMap((row) => {
      const parsed = connectionCandidate.safeParse(row.candidate);
      if (!parsed.success) return [];
      const candidate = parsed.data;
      return [
        {
          family: "recommendation" as const,
          assessmentId: row.id,
          status: filters.status,
          // Connections have no Automatic rule.
          matchedRules: [],
          automaticRule: null,
          fingerprint: row.fingerprint,
          // Connections stay individually reviewed (ADR 0016).
          clean: false,
          strength: connectionStrength(candidate.evidence),
          impact: connectionImpact[candidate.relation],
          createdAt: new Date(row.createdAt),
          columns: {
            relation: candidate.relation,
            entityKind: [
              ...new Set([
                candidate.source.entityKind,
                candidate.target.entityKind,
              ]),
            ],
            source: candidate.source.entityId,
            target: candidate.target.entityId,
          },
        },
      ];
    });
    return [...connectionKeys, ...(await tagSuggestionKeys(db, query))];
  },
  rows: async (db, keys) => {
    if (!keys.length) return new Map();
    const byId = new Map(keys.map((key) => [key.assessmentId, key]));
    const { rows: sources } = await unwrapDb(db).execute<{
      entityKind: string;
      entityId: string;
    }>(sql`
      SELECT DISTINCT a.evidence->'candidate'->${"source"}->>'entityKind' AS "entityKind",
        a.evidence->'candidate'->${"source"}->>'entityId' AS "entityId"
      FROM "Assessment" a
      WHERE ${reviewFamilyDeclarations.recommendation.scopes.connection} AND a.id IN (${sql.join(
        keys.map((key) => sql`${key.assessmentId}::uuid`),
        sql`, `,
      )})
    `);
    const found = await tagSuggestionRows(db, keys);
    // Stored only: readEntityConnectionsBatch rechecks evidence, never discovers.
    for (let start = 0; start < sources.length; start += READ_BATCH) {
      const groups = await readEntityConnectionsBatch(
        db,
        entityGraphRootSchema
          .array()
          .parse(sources.slice(start, start + READ_BATCH)),
      );
      for (const proposal of groups.flat()) {
        const key = byId.get(proposal.review.assessmentId);
        if (!key || found.has(key.assessmentId)) continue;
        const source = {
          entity: shortcodeEntity.parse(proposal.source.entityKind),
          id: proposal.source.entityId,
        };
        const target = {
          entity: shortcodeEntity.parse(proposal.target.entityKind),
          id: proposal.target.entityId,
        };
        found.set(
          key.assessmentId,
          recommendationSuggestionRow.parse({
            ...keyBase(key),
            fingerprint: proposal.fingerprint,
            family: "recommendation",
            record: source,
            other: target,
            summary: [
              { kind: "record", ref: source },
              { kind: "text", text: proposal.label },
              { kind: "record", ref: target },
            ],
            actions: connectionActions(proposal),
            evidence: proposal,
          }),
        );
      }
    }
    return found;
  },
  outcomes: async (db, filters) => {
    const { rows } = await unwrapDb(db).execute<{
      status: string;
      count: number;
    }>(sql`
      SELECT s.status, count(*)::int AS count
      FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
      WHERE a.family = ${assessmentFamily.enum.recommendation} AND ${reviewFamilyDeclarations.recommendation.scopes.connection}
        ${filters.runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runId})` : sql``}
      GROUP BY s.status
    `);
    const of = (status: string) =>
      rows.find((row) => row.status === status)?.count ?? 0;
    return {
      applied: of("applied"),
      rejected: of("rejected"),
      superseded: of("superseded"),
      resolved: of("resolved"),
      fields: [],
    };
  },
  acceptAsIs: () => null,
};

async function transferPairRows(
  db: Database,
  query: SuggestionFamilyQuery,
  ids?: readonly string[],
) {
  const entities: readonly ShortcodeEntity[] = [
    "financialAccount",
    "financialTransaction",
    "ledgerParty",
  ];
  if (query.filters.entity && !entities.includes(query.filters.entity))
    return [];
  if (
    query.records &&
    !query.records.some((record) => entities.includes(record.entity))
  )
    return [];
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    createdAt: Date | string;
    judgment: unknown;
    data: unknown;
  }>(sql`
    SELECT s.id, s.fingerprint, a."createdAt", a.judgment, s.data
    FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
    WHERE s.family = ${assessmentFamily.enum.transfer_pair} AND s.status = ${query.filters.status}
      AND ${assessmentIdScope(query.assessmentIds, sql`s.id`)}
      ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}
      ${query.filters.status === "pending" ? sql`AND s.active` : sql``}
      ${runCode(query) ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runCode(query)})` : sql``}
  `);
  if (!rows.length) return [];
  const current =
    query.filters.status === "pending" && !ids
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
      query.filters.entity &&
      !records.some((record) => record.entity === query.filters.entity)
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

const transferPair: SuggestionFamilyPresentation<"transfer_pair"> = {
  keys: async (db, query) =>
    (await transferPairRows(db, query)).map((row) => ({
      family: "transfer_pair",
      assessmentId: row.id,
      status: query.filters.status,
      fingerprint: row.fingerprint,
      clean: row.evidence.clean,
      strength: row.evidence.blockers.some((reason) =>
        [
          "weak_movement",
          "competing_candidates",
          "unresolved_overlap",
          "cash_leg_missing",
          "owner_missing",
        ].includes(reason),
      )
        ? "weak"
        : row.evidence.blockers.includes("date_gap")
          ? "medium"
          : "strong",
      impact: [outcome("Transfer paired")],
      createdAt: row.createdAt,
      matchedRules: [],
      automaticRule: null,
      columns: {
        date: row.evidence.date,
        amount: row.evidence.amount,
        dateGapDays: row.evidence.dateGapDays,
        account: [
          row.evidence.outflow.accountId,
          row.evidence.inflow.accountId,
        ],
        owner: [
          row.evidence.outflow.owner?.id ?? null,
          row.evidence.inflow.owner?.id ?? null,
        ],
        merchant: [
          row.evidence.outflow.merchant,
          row.evidence.inflow.merchant,
          row.evidence.outflow.description,
          row.evidence.inflow.description,
        ]
          .filter(Boolean)
          .join(" "),
      },
    })),
  rows: async (db, keys) => {
    if (!keys.length) return new Map();
    const rows = await transferPairRows(
      db,
      {
        filters: { status: keys[0]?.status ?? "pending", where: {} },
      },
      keys.map((key) => key.assessmentId),
    );
    const byId = new Map(keys.map((key) => [key.assessmentId, key]));
    return new Map(
      rows.flatMap((row) => {
        const key = byId.get(row.id);
        if (!key) return [];
        return [
          [
            row.id,
            transferPairSuggestionRow.parse({
              ...keyBase(key),
              family: "transfer_pair",
              record: {
                entity: "financialAccount",
                id: row.evidence.outflow.accountId,
              },
              other: {
                entity: "financialAccount",
                id: row.evidence.inflow.accountId,
              },
              summary: [
                { kind: "amount", amount: row.evidence.outflow.amount },
                { kind: "date", date: row.evidence.date },
                {
                  kind: "text",
                  text:
                    row.evidence.outflow.description ??
                    row.evidence.outflow.accountName,
                },
              ],
              actions: row.evidence.apply.available
                ? verbs("accept", "reject", "dismiss")
                : verbs("reject", "dismiss"),
              evidence: row.evidence,
            }),
          ],
        ];
      }),
    );
  },
  outcomes: async (db, filters) => {
    const { rows } = await unwrapDb(db).execute<{
      status: string;
      count: number;
    }>(sql`
      SELECT status, count(*)::int AS count FROM "AssessmentState"
      WHERE family = ${assessmentFamily.enum.transfer_pair}
        ${filters.runId ? sql`AND "runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runId})` : sql``}
      GROUP BY status
    `);
    const count = (status: string) =>
      rows.find((row) => row.status === status)?.count ?? 0;
    return {
      applied: count("applied"),
      rejected: count("rejected"),
      superseded: count("superseded"),
      resolved: count("resolved"),
      fields: [],
    };
  },
  acceptAsIs: (row) =>
    row.evidence.clean
      ? {
          assessmentId: row.assessmentId,
          operationId: crypto.randomUUID(),
          verdict: "correct",
          correction: { present: false },
          intent: "apply",
          expectedFingerprint: row.fingerprint,
          reason: null,
          evidence: null,
          application: { kind: "transfer_pair" },
        }
      : null,
};

/** The Suggestion family registry, keyed by Assessment family. */
export const suggestionFamilies = {
  field,
  statement_transaction: statementTransaction,
  recommendation,
  transfer_pair: transferPair,
  product_pair: productPairFamily,
  image_description: imageDescriptionFamily,
} satisfies {
  [F in SuggestionListFamily]: SuggestionFamilyPresentation<F>;
};

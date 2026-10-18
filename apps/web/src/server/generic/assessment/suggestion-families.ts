import type { assessmentReviewInput } from "@cubby/schemas/assessment";
import {
  type DataCheck,
  dataCheckKind,
  dataCheckPresentation,
  dataChecksByEntity,
} from "@cubby/schemas/data-quality";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  connectionCandidate,
  type connectionEvidence,
  type ConnectionProposal,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { requiresSuggestionReview } from "@cubby/schemas/field-suggestion";
import type {
  StatementSuggestionOut,
  StatementTransactionAction,
  StatementTransactionApplication,
} from "@cubby/schemas/statement-suggestion";
import {
  fieldSuggestionRow,
  recommendationSuggestionRow,
  statementSuggestionRow,
  type SuggestionImpact,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListRow,
  type SuggestionRecordRef,
  type SuggestionStrength,
  type SuggestionSummaryPart,
  type suggestionAction,
} from "@cubby/schemas/suggestion-list";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { readEntityConnectionsBatch } from "~/server/domains/connection/repo/entity-connections";
import {
  readStatementSuggestions,
  statementSuggestionKeys,
  statementSuggestionStatusCounts,
} from "~/server/domains/statement-import/repo/statement-suggestion-read";
import {
  fieldSuggestionKeys,
  readFieldSuggestions,
  suggestionCounts,
} from "~/server/generic/assessment/repo/suggestion-review";
import {
  lookupEntityLabels,
  resolveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

type ShortcodeEntity = SuggestionRecordRef["entity"];

/** The sort, Strength and Impact facts of one Suggestion, read before hydration. */
export type SuggestionKey = {
  family: SuggestionListFamily;
  assessmentId: string;
  fingerprint: string | null;
  clean: boolean;
  strength: SuggestionStrength;
  impact: SuggestionImpact[];
  createdAt: Date;
};

/** `records` is set when the caller filters by recordIds (resolved, maybe empty). */
export type SuggestionFamilyQuery = {
  filters: SuggestionListFilters;
  records?: { code: string; entity: ShortcodeEntity; id: string }[];
};

type ReviewItem = z.input<typeof assessmentReviewInput>;
type Action = z.infer<typeof suggestionAction>;
type RowOf<F extends SuggestionListFamily> = Extract<
  SuggestionListRow,
  { family: F }
>;

export type SuggestionOutcomes = {
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
type SuggestionFamilyPresentation<F extends SuggestionListFamily> = {
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
  kind: "outcome",
  label,
});

const keyBase = (key: SuggestionKey) => ({
  assessmentId: key.assessmentId,
  fingerprint: key.fingerprint,
  strength: key.strength,
  clean: key.clean,
  impact: key.impact,
  matchedRules: [],
  createdAt: key.createdAt.toISOString(),
});

const recordIdsOf = (
  query: SuggestionFamilyQuery,
  entities: readonly ShortcodeEntity[],
) =>
  query.records
    ?.filter((record) => entities.includes(record.entity))
    .map((record) => record.id);

// ---------------------------------------------------------------- field

const fieldChecks = new Map<string, DataCheck[]>();
for (const [entity, checks] of Object.entries(dataChecksByEntity))
  for (const check of checks.options) {
    const placement = dataCheckPresentation[check].placement;
    if (dataCheckKind[check] === "defect" || !("field" in placement)) continue;
    const key = `${entity}.${placement.field}`;
    fieldChecks.set(key, [...(fieldChecks.get(key) ?? []), check]);
  }

/** Strong needs an Addition the field lets apply without review, not confidence alone. */
const fieldStrength = (
  entity: ShortcodeEntity,
  field: string,
  kind: "correction" | "addition",
  confidence: number,
): SuggestionStrength =>
  confidence >= 0.85 &&
  kind === "addition" &&
  !requiresSuggestionReview(entity, field)
    ? "strong"
    : confidence >= 0.6
      ? "medium"
      : "weak";

const shortcodeEntity = z.enum(shortcodeEntities);

const field: SuggestionFamilyPresentation<"field"> = {
  keys: async (db, { filters, records }) => {
    const scope = filters.scope.field ?? {};
    const rows = await fieldSuggestionKeys(db, {
      status: filters.status,
      entities: filters.entity ? [filters.entity] : undefined,
      recordUuids: records?.map((record) => record.id),
      field: scope.field,
      fields: scope.fields,
      kind: scope.kind,
      minConfidence: scope.minConfidence,
      runId: filters.runId,
    });
    return rows.map((row) => {
      const entity = shortcodeEntity.parse(row.entity);
      const kind = z.enum(["correction", "addition"]).parse(row.kind);
      const strength = fieldStrength(entity, row.field, kind, row.confidence);
      return {
        family: "field" as const,
        assessmentId: row.id,
        fingerprint: row.fingerprint,
        strength,
        clean: strength === "strong",
        impact:
          kind === "addition"
            ? (fieldChecks.get(`${entity}.${row.field}`) ?? []).map(
                qualityImpact,
              )
            : [],
        createdAt: row.createdAt,
      };
    });
  },
  rows: async (db, keys) => {
    const rows = await readFieldSuggestions(
      db,
      keys.map((key) => key.assessmentId),
    );
    const refs = await resolveShortcodes(
      db,
      rows.map((row) => row.recordId),
    );
    const names = await lookupEntityLabels(db, [...refs.values()]);
    const byId = new Map(keys.map((key) => [key.assessmentId, key]));
    return new Map(
      rows.flatMap((row) => {
        const key = byId.get(row.assessmentId);
        if (!key) return [];
        const ref = refs.get(row.recordId);
        const summary: SuggestionSummaryPart[] =
          row.kind === "correction"
            ? [
                { kind: "field", entity: row.entity, field: row.field },
                { kind: "value", value: row.currentValue },
                { kind: "value", value: row.suggestedValue },
              ]
            : [
                { kind: "field", entity: row.entity, field: row.field },
                { kind: "value", value: row.suggestedValue },
              ];
        return [
          [
            row.assessmentId,
            fieldSuggestionRow.parse({
              ...keyBase(key),
              family: "field",
              record: {
                entity: row.entity,
                id: row.recordId,
                name: ref
                  ? (names.get(entityRefKey(ref.entity, ref.id)) ?? null)
                  : null,
              },
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

const statementImpact: Record<StatementTransactionAction, SuggestionImpact[]> =
  {
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
  };

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

const statementActionLabel: Record<StatementTransactionAction, string> = {
  create: "Create transaction",
  attach: "Attach to transaction",
  supersede: "Supersede pending hold",
  void: "Void hold",
};

const otherTransaction = (row: StatementSuggestionOut) => {
  if (row.recommended === "attach" && row.candidates[0])
    return {
      id: row.candidates[0].transactionId,
      name: row.candidates[0].merchant,
    };
  if (row.recommended === "supersede" && row.supersedeTransactionId)
    return { id: row.supersedeTransactionId, name: null };
  if (row.recommended === "void" && row.voidTransactionId)
    return { id: row.voidTransactionId, name: null };
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

const STATEMENT_ENTITIES: readonly ShortcodeEntity[] = [
  "financialAccount",
  "financialTransaction",
];

const statementTransaction: SuggestionFamilyPresentation<"statement_transaction"> =
  {
    keys: async (db, query) => {
      const { filters } = query;
      if (filters.status !== "pending") return [];
      if (filters.entity && !STATEMENT_ENTITIES.includes(filters.entity))
        return [];
      const recordUuids = recordIdsOf(query, STATEMENT_ENTITIES);
      if (recordUuids?.length === 0) return [];
      const rows = await statementSuggestionKeys(db, {
        ...filters.scope.statement_transaction,
        recordUuids,
        runCode: filters.runId,
      });
      return rows.map((row) => ({
        family: "statement_transaction" as const,
        assessmentId: row.id,
        fingerprint: row.fingerprint,
        clean: row.clean,
        strength: statementStrength(row),
        impact: statementImpact[row.recommended],
        createdAt: row.createdAt,
      }));
    },
    rows: async (db, keys) => {
      const rows = await readStatementSuggestions(
        db,
        keys.map((key) => key.assessmentId),
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
                record: {
                  entity: "financialAccount" as const,
                  id: row.accountId,
                  name: row.accountName,
                },
                ...(other
                  ? {
                      other: {
                        entity: "financialTransaction" as const,
                        ...other,
                      },
                    }
                  : {}),
                summary: [
                  { kind: "text", text: statementActionLabel[row.recommended] },
                  { kind: "amount", amount: row.amount },
                  { kind: "date", date: row.statementDate },
                  { kind: "text", text: row.merchant ?? row.rawDescription },
                ],
                // Dismissal suppresses the charge permanently.
                actions: verbs("accept", "correct", "dismiss"),
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

const connectionImpact: Record<ConnectionRelation, SuggestionImpact[]> = {
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
};

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
  if (proposal.integration.kind === "product-pair-review")
    return verbs("open_workbench");
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
  keys: async (db, { filters, records }) => {
    if (filters.status !== "pending") return [];
    const scope = filters.scope.recommendation ?? {};
    const endpoints = sql`ARRAY[a.evidence->'candidate'->'source'->>'entityKind' || ':' || (a.evidence->'candidate'->'source'->>'entityId'),
      a.evidence->'candidate'->'target'->>'entityKind' || ':' || (a.evidence->'candidate'->'target'->>'entityId')]`;
    const kinds = sql`ARRAY[a.evidence->'candidate'->'source'->>'entityKind', a.evidence->'candidate'->'target'->>'entityKind']`;
    const text = (values: readonly string[]) =>
      sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;
    if (records?.length === 0) return [];
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      fingerprint: string | null;
      createdAt: Date | string;
      candidate: unknown;
    }>(sql`
      SELECT a.id, a.fingerprint, a."createdAt", a.evidence->'candidate' AS candidate
      FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
      WHERE a.family = 'recommendation' AND a.served AND s.active AND s.status = 'pending'
        AND a.subject->>'scope' LIKE 'connection.%'
        AND NOT EXISTS (SELECT 1 FROM "Feedback" f WHERE f."assessmentId" = a.id
          AND f.authority = 'member' AND f.verdict IN ('wrong', 'dismissed'))
        AND NOT EXISTS (SELECT 1 FROM "AssessmentState" suppressed WHERE suppressed.active
          AND suppressed.entity = s.entity AND suppressed."recordId" = s."recordId"
          AND suppressed.suppression->>'scope' = a.subject->>'scope'
          AND suppressed.suppression->>'candidateKey' = a.subject->>'candidateKey'
          AND (suppressed.suppression->>'fingerprint' IS NULL OR suppressed.suppression->>'fingerprint' = a.fingerprint))
        ${records ? sql`AND ${endpoints} && ${text(records.map((record) => `${record.entity}:${record.code}`))}` : sql``}
        ${filters.entity ? sql`AND ${filters.entity} = ANY(${kinds})` : sql``}
        ${scope.relation ? sql`AND a.evidence->'candidate'->>'relation' = ${scope.relation}` : sql``}
        ${filters.runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runId})` : sql``}
    `);
    return rows.flatMap((row) => {
      const candidate = connectionCandidate.safeParse(row.candidate);
      if (!candidate.success) return [];
      return [
        {
          family: "recommendation" as const,
          assessmentId: row.id,
          fingerprint: row.fingerprint,
          // Connections stay individually reviewed (ADR 0016).
          clean: false,
          strength: connectionStrength(candidate.data.evidence),
          impact: connectionImpact[candidate.data.relation],
          createdAt: new Date(row.createdAt),
        },
      ];
    });
  },
  rows: async (db, keys) => {
    if (!keys.length) return new Map();
    const byId = new Map(keys.map((key) => [key.assessmentId, key]));
    const { rows: sources } = await unwrapDb(db).execute<{
      entityKind: string;
      entityId: string;
    }>(sql`
      SELECT DISTINCT a.evidence->'candidate'->'source'->>'entityKind' AS "entityKind",
        a.evidence->'candidate'->'source'->>'entityId' AS "entityId"
      FROM "Assessment" a
      WHERE a.id IN (${sql.join(
        keys.map((key) => sql`${key.assessmentId}::uuid`),
        sql`, `,
      )})
    `);
    const found = new Map<string, RowOf<"recommendation">>();
    // Stored only: readEntityConnectionsBatch rechecks evidence, never discovers.
    for (let start = 0; start < sources.length; start += READ_BATCH) {
      const chunk = sources.slice(start, start + READ_BATCH);
      const groups = await readEntityConnectionsBatch(
        db,
        entityGraphRootSchema.array().parse(chunk),
      );
      for (const proposal of groups.flat()) {
        const key = byId.get(proposal.review.assessmentId);
        if (!key || found.has(key.assessmentId)) continue;
        const source = {
          entity: shortcodeEntity.parse(proposal.source.entityKind),
          id: proposal.source.entityId,
          name: proposal.sourceName ?? null,
        };
        const target = {
          entity: shortcodeEntity.parse(proposal.target.entityKind),
          id: proposal.target.entityId,
          name: proposal.targetName ?? null,
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
      WHERE a.family = 'recommendation' AND a.subject->>'scope' LIKE 'connection.%'
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

/** The Suggestion family registry, keyed by Assessment family. */
export const suggestionFamilies: {
  [F in SuggestionListFamily]: SuggestionFamilyPresentation<F>;
} = {
  field,
  statement_transaction: statementTransaction,
  recommendation,
};

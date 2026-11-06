import { suggestionStatus } from "@cubby/schemas/ai";
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
  fieldSuggestionRow,
  recommendationSuggestionRow,
  statementSuggestionRow,
  transferPairSuggestionRow,
  type SuggestionColumnValue,
  type SuggestionCountsOut,
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
import { readStoredConnectionProposals } from "~/server/domains/connection/repo/entity-connections";
import {
  currentTransferPairs,
  transferPairEvidenceFingerprint,
  transferPairStateData,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import {
  readStatementSuggestions,
  statementSuggestionFacts,
  statementSuggestionKeys,
  type StatementSuggestionScope,
  statementSuggestionStatusCounts,
} from "~/server/domains/transaction-import/repo/statement-suggestion-read";
import { kindAgreed } from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import {
  reviewFamilyDeclarations,
  pendingRecommendationEligibility,
} from "~/server/generic/suggestions/repo/review-families";
import {
  fieldSuggestionKeys,
  readFieldSuggestions,
  suggestionCounts,
} from "~/server/generic/suggestions/repo/suggestion-review";

import {
  productPairFamily,
  imageDescriptionFamily,
} from "./stored-suggestion-families";
import { tagSuggestionKeys, tagSuggestionRows } from "./tag-suggestions";

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

const stamps = z.array(z.string()).catch([]);

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
      entities: filters.recordEntity ? [filters.recordEntity] : undefined,
      recordUuids: records?.map((record) => record.id),
      runId: runCode(query),
      suggestionIds: query.suggestionIds,
    });
    return rows.map((row) => {
      const entity = shortcodeEntity.parse(row.entity);
      const kind = fieldKind.parse(row.kind);
      const strength = fieldStrength(row.confidence);
      return {
        family: "field" as const,
        suggestionId: row.id,
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
      keys.map((key) => key.suggestionId),
    );
    const byId = new Map(keys.map((key) => [key.suggestionId, key]));
    return new Map(
      rows.flatMap((row) => {
        const key = byId.get(row.suggestionId);
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
            row.suggestionId,
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
      entity: filters.recordEntity,
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
    suggestionId: row.suggestionId,
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

const owesFamily = (entity: ShortcodeEntity, family: SuggestionListFamily) =>
  entityRoster[entity].suggestionFamilies.some((owed) => owed === family);
const entitiesOwing = (family: SuggestionListFamily) =>
  shortcodeEntities.filter((entity) => owesFamily(entity, family));
const STATEMENT_ENTITIES = entitiesOwing("statement_transaction");
const TRANSFER_ENTITIES = entitiesOwing("transfer_pair");

function statementScope(
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

const statementTransaction: SuggestionFamilyPresentation<"statement_transaction"> =
  {
    facts: (query, needs) => {
      const scope = statementScope(query);
      return scope ? statementSuggestionFacts(scope, needs) : null;
    },
    keys: async (db, query) => {
      const scope = statementScope(query);
      if (!scope) return [];
      const status = scope.status ?? "pending";
      const rows = await statementSuggestionKeys(db, scope);
      return rows.map((row) => ({
        family: "statement_transaction" as const,
        suggestionId: row.id,
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
        keys.map((key) => key.suggestionId),
        keys[0]?.status === "applied" ? "applied" : "pending",
      );
      const byId = new Map(keys.map((key) => [key.suggestionId, key]));
      return new Map(
        rows.flatMap((row) => {
          const key = byId.get(row.suggestionId);
          if (!key) return [];
          const other = otherTransaction(row);
          return [
            [
              row.suggestionId,
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
            suggestionId: row.suggestionId,
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

const connectionImpactCount = sql.join(
  Object.entries(connectionImpact).map(
    ([relation, impacts]) =>
      sql`WHEN ${`connection.${relation}`} THEN ${impacts.filter((impact) => "qualityCheck" in impact).length}::int`,
  ),
  sql` `,
);

const recommendation: SuggestionFamilyPresentation<"recommendation"> = {
  facts: (query, needs) => {
    if (query.filters.status !== "pending") return null;
    const has = (...names: string[]) => names.some((name) => needs.has(name));
    const target = (key: "entityKind" | "entityId") =>
      sql`s.data->'connectionTarget'->>${key}`;
    const { recordEntity, runId } = query.filters;
    const reasons = sql`s.evidence#>'{candidate,evidence,reasons}'`;
    const retrieved = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${reasons}) = 'array' THEN ${reasons} ELSE '[]'::jsonb END) reason(value)
      WHERE starts_with(reason.value, ${RETRIEVED_REASON}))`;
    const contradicted = sql`coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(s.evidence#>'{candidate,evidence,contradictions}') = 'array' THEN s.evidence#>'{candidate,evidence,contradictions}' END), 0) > 0`;
    return {
      columns: {
        clean: sql`false`,
        // `connectionStrength` over the slim candidate; tag additions are medium.
        strength: sql`CASE WHEN s.evidence->'candidate' IS NULL THEN ${"medium"}
          WHEN ${retrieved} THEN CASE WHEN ${contradicted} THEN ${"weak"} ELSE ${"medium"} END
          WHEN ${contradicted} THEN ${"medium"} ELSE ${"strong"} END`,
        createdAt: sql`to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        impact: sql`CASE s.subject->>'scope' ${connectionImpactCount} ELSE 0 END`,
        relation: sql`substr(s.subject->>'scope', ${"connection.".length + 1})`,
        entityKind: sql`array_remove(ARRAY[s.entity, ${target("entityKind")}], NULL)`,
        source: sql`source_identity.shortcode`,
        target: target("entityId"),
      },
      from: sql.join(
        [
          sql`"Suggestion" s`,
          ...(has("source")
            ? [
                sql`LEFT JOIN "Entity" source_identity ON source_identity.id = s."recordId"`,
              ]
            : []),
        ],
        sql` `,
      ),
      where: sql`s.family = ${suggestionFamily.enum.recommendation} AND s.active
        AND s.status = ${suggestionStatus.enum.pending}
        AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
        ${recordEntity ? sql`AND (s.entity = ${recordEntity} OR ${target("entityKind")} = ${recordEntity})` : sql``}
        ${runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runId})` : sql``}`,
    };
  },
  keys: async (db, query) => {
    const { filters, records } = query;
    if (filters.status !== "pending") return [];
    if (records?.length === 0) return [];
    const side = (end: "source" | "target", key: "entityKind" | "entityId") =>
      sql`(s.evidence->'candidate'->${end}->>${key})`;
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
      SELECT s.id, s.fingerprint, s."createdAt", s.evidence->'candidate' AS candidate
      FROM "Suggestion" s
      WHERE s.family = ${suggestionFamily.enum.recommendation} AND s.served AND s.active
        AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
        AND s.status = ${suggestionStatus.enum.pending}
        AND ${reviewFamilyDeclarations.recommendation.scopes.connection}
        AND ${pendingRecommendationEligibility()}
        ${roster ? sql`AND (${endpoint("source")} IN (${roster}) OR ${endpoint("target")} IN (${roster}))` : sql``}
        ${filters.recordEntity ? sql`AND (${side("source", "entityKind")} = ${filters.recordEntity} OR ${side("target", "entityKind")} = ${filters.recordEntity})` : sql``}
        ${run ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${run})` : sql``}
    `);
    const connectionKeys = rows.flatMap((row) => {
      const parsed = connectionCandidate.safeParse(row.candidate);
      if (!parsed.success) return [];
      const candidate = parsed.data;
      return [
        {
          family: "recommendation" as const,
          suggestionId: row.id,
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
    const byId = new Map(keys.map((key) => [key.suggestionId, key]));
    const found = await tagSuggestionRows(db, keys);
    const addProposal = (proposal: ConnectionProposal) => {
      const key = byId.get(proposal.review.suggestionId);
      if (!key || found.has(key.suggestionId)) return;
      const source = {
        entity: shortcodeEntity.parse(proposal.source.entityKind),
        id: proposal.source.entityId,
      };
      const target = {
        entity: shortcodeEntity.parse(proposal.target.entityKind),
        id: proposal.target.entityId,
      };
      found.set(
        key.suggestionId,
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
    };
    for (const proposal of await readStoredConnectionProposals(
      db,
      keys.map((key) => key.suggestionId),
    ))
      addProposal(proposal);
    return found;
  },
  outcomes: async (db, filters) => {
    const { rows } = await unwrapDb(db).execute<{
      status: string;
      count: number;
    }>(sql`
      SELECT s.status, count(*)::int AS count
      FROM "Suggestion" s
      WHERE s.family = ${suggestionFamily.enum.recommendation}
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

const TRANSFER_WEAK_BLOCKERS = [
  "weak_movement",
  "competing_candidates",
  "unresolved_overlap",
  "cash_leg_missing",
  "owner_missing",
];

const transferPair: SuggestionFamilyPresentation<"transfer_pair"> = {
  facts: (query) => {
    const { status, runId } = query.filters;
    const legs = ["outflow", "inflow"] as const;
    const legArray = (value: (end: (typeof legs)[number]) => SQL) =>
      sql`array_remove(ARRAY[${sql.join(legs.map(value), sql`, `)}], NULL)`;
    return {
      columns: {
        clean: sql`coalesce((s.judgment->>'clean')::boolean, false)`,
        strength: sql`CASE WHEN s.judgment->'blockers' ?| ARRAY[${sql.join(
          TRANSFER_WEAK_BLOCKERS.map((blocker) => sql`${blocker}`),
          sql`, `,
        )}]::text[] THEN ${"weak"}
          WHEN s.judgment->'blockers' ? ${"date_gap"} THEN ${"medium"} ELSE ${"strong"} END`,
        createdAt: sql`to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        date: sql`s.judgment->>${"date"}`,
        amount: sql`s.judgment->>${"amount"}`,
        dateGapDays: sql`s.judgment->>${"dateGapDays"}`,
        account: legArray((end) => sql`s.judgment->${end}->>${"accountId"}`),
        owner: legArray((end) => sql`s.judgment->${end}->${"owner"}->>${"id"}`),
        merchant: sql`ARRAY[concat_ws(' ', ${sql.join(
          [
            ...legs.map((end) => sql`s.judgment->${end}->>${"merchant"}`),
            ...legs.map((end) => sql`s.judgment->${end}->>${"description"}`),
          ],
          sql`, `,
        )})]`,
      },
      from: sql`"Suggestion" s`,
      where: sql`s.family = ${suggestionFamily.enum.transfer_pair} AND s.status = ${status}
        ${status === suggestionStatus.enum.pending ? sql`AND s.active` : sql``}
        AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
        ${runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runId})` : sql``}`,
    };
  },
  keys: async (db, query) =>
    (await transferPairRows(db, query)).map((row) => ({
      family: "transfer_pair",
      suggestionId: row.id,
      status: query.filters.status,
      fingerprint: row.fingerprint,
      clean: row.evidence.clean,
      strength: row.evidence.blockers.some((reason) =>
        TRANSFER_WEAK_BLOCKERS.includes(reason),
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
        filters: { status: keys[0]?.status ?? "pending" },
      },
      keys.map((key) => key.suggestionId),
    );
    const byId = new Map(keys.map((key) => [key.suggestionId, key]));
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
      SELECT status, count(*)::int AS count FROM "Suggestion"
      WHERE family = ${suggestionFamily.enum.transfer_pair}
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
          suggestionId: row.suggestionId,
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

/** The Suggestion family registry, keyed by Suggestion family. */
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

import { suggestionStatus } from "@cubby/schemas/ai";
import {
  suggestionFamily,
  type SuggestionFamily,
} from "@cubby/schemas/suggestion";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { outer, type RelatedColumns } from "~/server/db/helpers/related";
import { suggestionTable, run } from "~/server/db/schema";
import { financialSourceReferenceRows } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { type SuggestionRecordSelection } from "~/server/generic/suggestions/repo/pending-admission";
import { suggestionFamilies as reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  ReviewFamily,
  reviewState,
  statementSettlementMatch,
  reviewQueryBuilder,
  statementSettlementRelation,
  statementSettlementEligibility,
  isReviewFamily,
  statementReferenceMatch,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import { automaticSuggestionEligibility } from "~/server/generic/suggestions/repo/suggestion-work-tokens";

export { pendingRecommendationEligibility } from "~/server/generic/suggestions/repo/pending-admission";

type SuggestionEligibility =
  | {
      kind: "suggestions";
      families: readonly ReviewFamily[];
      status: z.infer<typeof suggestionStatus>;
      runCode?: string;
    }
  | {
      kind: "automatic";
      family?: ReviewFamily;
      /** The caller's applied-rule expression for an Suggestion id; null when none applied. */
      appliedRule: (suggestionId: SQL) => SQL;
    };

export type SuggestionRecordScope = SuggestionRecordSelection & {
  eligibility: SuggestionEligibility;
};

function suggestionStateAdmission(
  db: Database,
  eligibility: SuggestionEligibility,
  s: Pick<
    RelatedColumns<typeof suggestionTable>,
    "family" | "status" | "active" | "runId"
  > = {
    family: outer(reviewState.family),
    status: outer(reviewState.status),
    active: outer(reviewState.active),
    runId: outer(reviewState.runId),
  },
) {
  if (eligibility.kind === "automatic")
    return and(
      inArray(
        s.family,
        Object.keys(reviewFamilyDeclarations).map((family) =>
          suggestionFamily.parse(family),
        ),
      ),
      eligibility.family ? eq(s.family, eligibility.family) : undefined,
    );
  return and(
    inArray(s.family, [...eligibility.families]),
    eq(s.status, eligibility.status),
    eligibility.status === suggestionStatus.enum.pending ? s.active : undefined,
    eligibility.runCode
      ? eq(
          s.runId,
          unwrapDb(db)
            .select({ id: run.id })
            .from(run)
            .where(eq(run.shortcode, eligibility.runCode)),
        )
      : undefined,
  );
}

/** Settlement-only scopes can discover immutable identities from the graph first. */
function settlementSuggestionQuery(db: Database, scope: SuggestionRecordScope) {
  if (!scope.records?.length) return undefined;
  const match = statementSettlementMatch(scope);
  if (!match) return undefined;
  const keys = reviewQueryBuilder
    .selectDistinct({
      source: sql<string>`evidence.source`.as("source"),
      externalId: sql<string>`evidence."externalId"`.as("externalId"),
    })
    .from(statementSettlementRelation)
    .innerJoin(
      sql`${financialSourceReferenceRows} evidence`,
      sql`evidence.owner=settled.id`,
    )
    .where(and(statementSettlementEligibility, match));
  const keyName = sql.identifier("settlement_keys");
  const keySource = sql<string>`${keyName}.${sql.identifier("source")}`;
  const keyExternalId = sql<string>`${keyName}.${sql.identifier("externalId")}`;
  const indexed = alias(suggestionTable, "settlement_indexed");
  const source = sql<string>`${indexed.judgment} #>> '{create,sourceRef,source}'`;
  const externalId = sql<string>`${indexed.judgment} #>> '{create,sourceRef,externalId}'`;
  // Bounded hashes support unrestricted historical text. Exact comparisons
  // retain identity authority even if two extracted values hash alike.
  const publications = reviewQueryBuilder
    .select({
      id: indexed.id,
      family: indexed.family,
      status: indexed.status,
    })
    .from(indexed)
    .where(
      and(
        eq(indexed.family, suggestionFamily.enum.statement_transaction),
        suggestionStateAdmission(db, scope.eligibility, {
          family: outer(indexed.family),
          status: outer(indexed.status),
          active: outer(indexed.active),
          runId: outer(indexed.runId),
        }),
        isNotNull(source),
        isNotNull(externalId),
        eq(sql`md5(${source})`, sql`md5(${keySource})`),
        eq(sql`md5(${externalId})`, sql`md5(${keyExternalId})`),
        eq(source, keySource),
        eq(externalId, keyExternalId),
      ),
    );
  const matched = sql.identifier("settlement_matched");
  const column = (name: string) => sql`${matched}.${sql.identifier(name)}`;
  const retained = unwrapDb(db)
    .select({
      id: sql<string>`${column("id")}`.as("id"),
      family: sql<SuggestionFamily>`${column("family")}`.as("family"),
      immutableFamily: sql<SuggestionFamily>`${column("family")}`.as(
        "immutableFamily",
      ),
      status: sql<string>`${column("status")}`.as("status"),
    })
    .from(sql`(${keys.getSQL()}) AS ${keyName}`)
    .innerJoinLateral(
      sql`(${publications.getSQL()} OFFSET 0) AS ${matched}`,
      sql`true`,
    )
    .getSQL();
  const acceptedKeys = reviewQueryBuilder
    .selectDistinct({
      transactionId: sql<string>`settled.id`.as("transactionId"),
    })
    .from(statementSettlementRelation)
    .where(and(statementSettlementEligibility, match));
  const accepted = sql`SELECT s.id,s.family,s.family AS "immutableFamily",s.status
    FROM (${acceptedKeys.getSQL()}) accepted_keys
    JOIN "SourceOccurrence" owner ON owner."acceptedTransactionId"=accepted_keys."transactionId"
    JOIN "SourceTransactionRecord" anchor ON anchor."occurrenceId"=owner.id
    JOIN "Suggestion" s ON s."recordId"=anchor.id
    WHERE s.family=${suggestionFamily.enum.statement_transaction}
      AND ${suggestionStateAdmission(db, scope.eligibility)}`;
  // Both arms start at the requested settlement graph and keep their own lookup indexes.
  return sql`${retained} UNION ALL ${accepted}`;
}

/** Scope identities before expensive automatic receipts; retain a statement-local barrier. */
function touchingSuggestionQuery(db: Database, scope: SuggestionRecordScope) {
  const client = unwrapDb(db);
  const s = reviewState;
  const families =
    scope.eligibility.kind === "suggestions"
      ? scope.eligibility.families
      : scope.eligibility.family
        ? [scope.eligibility.family]
        : Object.keys(reviewFamilyDeclarations)
            .map((family) => suggestionFamily.parse(family))
            .filter(isReviewFamily);
  const stateAdmission = suggestionStateAdmission(db, scope.eligibility);
  const branches = families.flatMap((family) => {
    const settlement =
      family === suggestionFamily.enum.statement_transaction
        ? settlementSuggestionQuery(db, scope)
        : undefined;
    // Candidate/direct reach remains independent when settlement discovery starts at requested FTXs.
    const matches = settlement
      ? statementReferenceMatch(scope, false)
      : reviewFamilyDeclarations[family].affectedRecords.reverse(scope);
    const direct = matches.flatMap((match) =>
      match
        ? [
            client
              .select({
                id: s.id,
                family: s.family,
                immutableFamily: sql<SuggestionFamily>`${s.family}`.as(
                  "immutableFamily",
                ),
                status: s.status,
              })
              .from(s)
              .where(and(stateAdmission, eq(s.family, family), match))
              .getSQL(),
          ]
        : [],
    );
    return settlement ? [...direct, settlement] : direct;
  });
  const matched = branches.length
    ? sql.join(branches, sql` UNION ALL `)
    : sql`SELECT NULL::uuid AS id, NULL::text AS family, NULL::text AS "immutableFamily", NULL::text AS status WHERE false`;
  if (scope.eligibility.kind === "suggestions") return matched;
  // Keep receipt validation outside identity discovery. Reading the scoped
  // family/status directly prevents the planner from scanning Suggestion again
  // and validating receipts before the matched-id join. Held pending corrections
  // still enter through the same candidate and authority checks.
  return sql`WITH matched AS MATERIALIZED (
    SELECT DISTINCT id, family, status FROM (${matched}) identities)
    SELECT DISTINCT matched.id, matched.family, matched.family AS "immutableFamily"
    FROM matched JOIN "Suggestion" s ON s.id = matched.id
    WHERE ${automaticSuggestionEligibility(scope.eligibility.appliedRule(sql`${s.id}`))}`;
}

/** Adapters use both State and immutable family authority after discovery. */
export async function touchingSuggestionFamilies(
  db: Database,
  scope: SuggestionRecordScope,
): Promise<Map<string, readonly SuggestionFamily[]> | null> {
  if (!scope.entity && !scope.records) return null;
  if (scope.records?.length === 0)
    return new Map<string, readonly SuggestionFamily[]>();
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    family: SuggestionFamily;
    immutableFamily: SuggestionFamily;
  }>(touchingSuggestionQuery(db, scope));
  return new Map(
    rows.map((row) => [row.id, [row.family, row.immutableFamily]]),
  );
}

export async function touchingSuggestionIds(
  db: Database,
  scope: SuggestionRecordScope,
): Promise<Set<string> | null> {
  const touching = await touchingSuggestionFamilies(db, scope);
  return touching ? new Set(touching.keys()) : null;
}

/** Pending image admission shared by Suggestions and record-scoped Work summaries.
 * Callers select from Suggestion s.
 */
export function pendingImageDescriptionEligibility() {
  return sql`s.family = ${suggestionFamily.enum.image_description}
    AND s.active AND s.status = ${suggestionStatus.enum.pending}
    AND s.suppression IS NULL AND ${reviewFamilyDeclarations.image_description.actionable}
    AND EXISTS (SELECT 1 FROM "Image" i WHERE i.id = s."recordId" AND ${notDeleted("i")})`;
}

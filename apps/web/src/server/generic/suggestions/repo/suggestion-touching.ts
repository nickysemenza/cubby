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
import { outer, type RelatedColumns } from "~/server/db/helpers/related";
import { requested, textArrayParam } from "~/server/db/helpers/requested";
import { suggestionTable, run } from "~/server/db/schema";
import { financialSourceReferenceRows } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { type SuggestionRecordSelection } from "~/server/generic/suggestions/repo/pending-admission";
import { suggestionFamilies as reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  ReviewFamily,
  reviewSuggestion,
  statementSettlementMatch,
  reviewQueryBuilder,
  statementSettlementRelation,
  statementSettlementEligibility,
  isReviewFamily,
  statementSourceMatch,
  settlementPaths,
  type JsonPath,
  type Reference,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import { automaticSuggestionEligibility } from "~/server/generic/suggestions/repo/suggestion-work-tokens";

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
    family: outer(reviewSuggestion.family),
    status: outer(reviewSuggestion.status),
    active: outer(reviewSuggestion.active),
    runId: outer(reviewSuggestion.runId),
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
function settlementSuggestionQuery(
  db: Database,
  scope: SuggestionRecordScope,
  admission: (alias?: string) => SQL | undefined,
) {
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
        admission("settlement_indexed"),
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
      AND ${admission()}`;
  // Both arms start at the requested settlement graph and keep their own lookup indexes.
  return sql`${retained} UNION ALL ${accepted}`;
}

/** The statement settlement graph is the only non-path discovery arm. */
export function statementGraph(
  db: Database,
  scope: SuggestionRecordScope,
  admission: (alias?: string) => SQL | undefined,
) {
  const query = settlementSuggestionQuery(db, scope, admission);
  const matches: (SQL | undefined)[] = [...statementSourceMatch(scope)];
  if (!query) {
    const settled = statementSettlementMatch(scope);
    if (settled)
      matches.push(
        ...settlementPaths.map(
          ([from, where]) =>
            sql`EXISTS (SELECT 1 ${from} WHERE ${where} AND ${settled})`,
        ),
      );
  }
  return { matches, query };
}

const json = (at: JsonPath, text = false, name = "s"): SQL<string> => {
  const column = sql<string>`${sql.identifier(name)}.${sql.identifier(at.column)}`;
  if (!at.path?.length) return text ? sql<string>`${column} #>> '{}'` : column;
  const path = sql`ARRAY[${sql.join(
    at.path.map((part) => sql`${part}`),
    sql`, `,
  )}]::text[]`;
  return text
    ? sql<string>`${column} #>> ${path}`
    : sql<string>`${column} #> ${path}`;
};

function referenceMatches(
  ref: Reference,
  scope: SuggestionRecordScope,
  family: ReviewFamily,
  admission: (alias?: string) => SQL | undefined,
): SQL | undefined {
  const set = scope.records ? requested(scope.records) : undefined;
  const guard = ref.guard;
  const guardSql = and(
    guard?.entity ? eq(reviewSuggestion.entity, guard.entity) : undefined,
    guard?.field ? eq(reviewSuggestion.field, guard.field) : undefined,
    guard?.scope
      ? guard.negate
        ? sql`(s.subject->>'scope' LIKE ${`${guard.scope}.%`}) IS NOT TRUE`
        : sql`s.subject->>'scope' LIKE ${`${guard.scope}.%`}`
      : undefined,
  );
  const match = (entity: string | SQL, token: SQL<string>) => {
    if (
      typeof entity === "string" &&
      ((scope.entity && scope.entity !== entity) ||
        (set && !set.entities.has(entity)))
    )
      return undefined;
    return and(
      scope.entity && typeof entity !== "string"
        ? eq(entity, scope.entity)
        : undefined,
      set ? set.match({ entity, token }) : isNotNull(token),
    );
  };
  if (ref.kind === "primary")
    return and(
      guardSql,
      scope.entity ? eq(reviewSuggestion.entity, scope.entity) : undefined,
      set
        ? set.match({
            entity: sql`${reviewSuggestion.entity}`,
            id: sql`${reviewSuggestion.recordId}`,
          })
        : sql`true`,
    );
  if (ref.kind === "contains") {
    const array = json(ref.at);
    if (!set)
      return and(
        guardSql,
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${array}, '[]'::jsonb)) r WHERE ${match(sql`r->>'entity'`, sql<string>`r->>'id'`)})`,
      );
    const needles = (scope.records ?? [])
      .filter((record) => !scope.entity || record.entity === scope.entity)
      .flatMap((record) =>
        [record.id, record.code, ...set.keysOf(record)].map((id) =>
          JSON.stringify([{ entity: record.entity, id }]),
        ),
      );
    if (!needles.length) return undefined;
    const indexed = alias(suggestionTable, "retained_indexed");
    const indexedPath =
      ref.at.path?.length === 1
        ? sql`${sql.identifier("retained_indexed")}.${sql.identifier(ref.at.column)}->${ref.at.path[0]}`
        : json(ref.at, false, "retained_indexed");
    const probe = reviewQueryBuilder
      .select({ id: indexed.id })
      .from(indexed)
      .where(
        and(
          eq(indexed.family, family),
          admission("retained_indexed"),
          sql`${indexedPath} @> n.value::jsonb`,
        ),
      );
    const ids = sql`SELECT hit.id FROM unnest(${textArrayParam(needles)}) n(value) JOIN LATERAL (${probe.getSQL()} OFFSET 0) hit ON true WHERE ${set.match({ entity: sql`n.value::jsonb->0->>'entity'`, token: sql<string>`n.value::jsonb->0->>'id'` })}`;
    return and(guardSql, sql`${reviewSuggestion.id} IN (${ids})`);
  }
  const entity =
    typeof ref.entity === "string" ? ref.entity : json(ref.entity, true);
  if (ref.kind === "value") {
    const condition = match(entity, json(ref.at, true));
    return condition ? and(guardSql, condition) : undefined;
  }
  const value = json(ref.at);
  const elements = ref.scalar
    ? sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE jsonb_build_array(${value}) END`
    : sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END`;
  const token = ref.scalar
    ? sql<string>`COALESCE(v->>'id', v #>> '{}')`
    : sql<string>`v #>> ARRAY[${sql.join(
        (ref.idPath ?? []).map((part) => sql`${part}`),
        sql`, `,
      )}]::text[]`;
  const condition = match(entity, token);
  return condition
    ? and(
        guardSql,
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${elements}) v WHERE ${condition})`,
      )
    : undefined;
}

/** Scope identities before expensive automatic receipts; retain a statement-local barrier. */
export function touchingSuggestionQuery(
  db: Database,
  scope: SuggestionRecordScope,
) {
  const client = unwrapDb(db);
  const s = reviewSuggestion;
  const families =
    scope.eligibility.kind === "suggestions"
      ? scope.eligibility.families
      : scope.eligibility.family
        ? [scope.eligibility.family]
        : Object.keys(reviewFamilyDeclarations)
            .map((family) => suggestionFamily.parse(family))
            .filter(isReviewFamily);
  const admission = (name?: string) => {
    if (!name) return suggestionStateAdmission(db, scope.eligibility);
    const columns = alias(suggestionTable, name);
    return suggestionStateAdmission(db, scope.eligibility, {
      family: outer(columns.family),
      status: outer(columns.status),
      active: outer(columns.active),
      runId: outer(columns.runId),
    });
  };
  const stateAdmission = admission();
  const branches = families.flatMap((family) => {
    const declaration = reviewFamilyDeclarations[family].affectedRecords;
    const graph = declaration.graph?.(db, scope, admission);
    const settlement = graph?.query;
    const matches = [
      ...declaration.references.map((ref) =>
        referenceMatches(ref, scope, family, admission),
      ),
      ...(graph?.matches ?? []),
    ];
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
  const rows = await unwrapDb(db).execute<{
    id: string;
    family: SuggestionFamily;
    immutableFamily: SuggestionFamily;
  }>(touchingSuggestionQuery(db, scope), "objects");
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

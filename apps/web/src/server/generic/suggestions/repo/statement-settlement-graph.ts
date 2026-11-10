import {
  suggestionFamily,
  type SuggestionFamily,
} from "@cubby/schemas/suggestion";
import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { financialSourceReferenceRows } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import {
  reviewQueryBuilder,
  settlementPaths,
  statementSettlementEligibility,
  statementSettlementMatch,
  statementSettlementRelation,
  statementSourceMatch,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import type { SuggestionRecordScope } from "~/server/generic/suggestions/repo/suggestion-touching";

// The statement family declaration imports this graph, so it must not import
// the family registry (directly or through suggestion-touching at runtime).

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

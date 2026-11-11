import { suggestionStatus } from "@cubby/schemas/ai";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
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
import { textArrayParam } from "~/server/db/helpers/query";
import { outer, type RelatedColumns } from "~/server/db/helpers/related";
import { requested, type Requested } from "~/server/db/helpers/requested";
import { suggestionTable, run } from "~/server/db/schema";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { type SuggestionRecordSelection } from "~/server/generic/suggestions/repo/pending-admission";
import { suggestionFamilies as reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  ReviewFamily,
  reviewSuggestion,
  reviewQueryBuilder,
  isReviewFamily,
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

/** The queue's state admission; badges and the touching query share it. */
export function suggestionStateAdmission(
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
  set: Requested | undefined,
): SQL | undefined {
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
    if (
      ref.kind !== "primary" &&
      ref.kind !== "contains" &&
      ref.resolve &&
      typeof entity === "string"
    ) {
      const parsed = z.enum(shortcodeEntities).safeParse(entity);
      if (!parsed.success) return undefined;
      const table = SHORTCODE_TABLE[parsed.data];
      return sql`EXISTS (SELECT 1 FROM ${table} ref_record WHERE ref_record.shortcode = ${token}
        AND ${notDeleted("ref_record")}
        AND ${set ? set.match({ entity, id: sql`ref_record.id` }) : sql`true`})`;
    }
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
        // Containment is exact, so probe each key in both cases stored references use.
        [
          ...new Set(
            [record.id, record.code, ...set.keysOf(record)].flatMap((key) =>
              key ? [key, key.toLowerCase()] : [],
            ),
          ),
        ].map((id) => JSON.stringify([{ entity: record.entity, id }])),
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
  const set = scope.records ? requested(scope.records) : undefined;
  const branches = families.flatMap((family) => {
    const declaration = reviewFamilyDeclarations[family].affectedRecords;
    const graph = declaration.graph?.(db, scope, admission);
    const settlement = graph?.query;
    const matches = [
      ...declaration.references.map((ref) =>
        referenceMatches(ref, scope, family, admission, set),
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

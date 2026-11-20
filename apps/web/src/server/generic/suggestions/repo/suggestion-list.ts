import {
  acceptCleanSuggestionsInput,
  type acceptCleanSuggestionsOut,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionListFamily,
  suggestionListInput,
  suggestionListOut,
  type SuggestionColumnValue,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListRow,
  type SuggestionStrength,
} from "@cubby/schemas/suggestion-list";
import { suggestionFilterDeclaration } from "@cubby/schemas/suggestion-list-declarations";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, unwrapDb } from "~/server/db/helpers";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { compileDeclaredFilters } from "~/server/generic/list/repo/declared-filters";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { reviewSuggestionBatch } from "~/server/generic/suggestions/repo/review";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  type SuggestionFactQuery,
  type SuggestionFamilyQuery,
  type SuggestionKey,
  emptyPendingCounts,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import { touchingSuggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-touching";
import { jsonCursor } from "~/server/lib/json-cursor";

const STRENGTH_RANK = { strong: 2, medium: 1, weak: 0 } as const;
const ARRAY_COLUMNS = new Set(
  suggestionFilterDeclaration.descriptors
    .filter((descriptor) => descriptor.stored.array)
    .map((descriptor) => descriptor.columnId),
);
const NUMBER_COLUMNS = new Set([
  "amount",
  "confidence",
  "dateGapDays",
  "impact",
]);

const suggestionCursor = jsonCursor(
  z.object({
    order: z.string(),
    vector: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    id: z.string(),
  }),
  { invalid: "Invalid suggestion list cursor" },
);

type SortTerm = { by: string; direction: "asc" | "desc" };

/**
 * Family eligibility owns current evidence and its derived facts. Project that
 * validated fact stream as a relation; the shared compiler is the only owner
 * of filter operators, and PostgreSQL owns ordering and paging.
 */
function suggestionKeyFacts(key: SuggestionKey) {
  return {
    id: key.suggestionId,
    family: key.family,
    strength: key.strength,
    strengthRank: STRENGTH_RANK[key.strength],
    clean: String(key.clean),
    createdAt: key.createdAt.toISOString(),
    impact: key.impact.filter((impact) => impact.qualityCheck).length,
    ...Object.fromEntries(
      Object.entries(key.columns).map(([name, value]) => [
        name,
        ARRAY_COLUMNS.has(name)
          ? [value].flat().filter((item) => item !== null)
          : Array.isArray(value)
            ? value.filter((item) => item !== null).join(" ")
            : value,
      ]),
    ),
    // One unit everywhere: the 0 to 1 probability rows carry.
    confidence:
      typeof key.columns.confidence === "number"
        ? key.columns.confidence
        : null,
  };
}

const FACT_COLUMNS = [
  ...new Set([
    "id",
    "family",
    "strength",
    "strengthRank",
    "clean",
    "createdAt",
    "impact",
    "month",
    "source",
    "target",
    ...suggestionFilterDeclaration.filters.map((filter) => filter.columnId),
  ]),
];

const typedFact = (name: string, value: SQL) =>
  sql`(${value})::${sql.raw(
    ARRAY_COLUMNS.has(name)
      ? "text[]"
      : NUMBER_COLUMNS.has(name) || name === "strengthRank"
        ? "numeric"
        : "text",
  )} AS ${sql.identifier(name)}`;

/** Keys of the small families read as JSON, in the same shape as family facts. */
function keysFactSelect(keys: readonly SuggestionKey[]) {
  const facts = keys.map(suggestionKeyFacts);
  const columns = FACT_COLUMNS.map((name) => {
    const text = sql`fact.value->>${name}`;
    return typedFact(
      name,
      ARRAY_COLUMNS.has(name)
        ? sql`ARRAY(SELECT jsonb_array_elements_text(fact.value->${name}))`
        : text,
    );
  });
  return sql`SELECT ${sql.join(columns, sql`, `)}
    FROM jsonb_array_elements(${JSON.stringify(facts)}::jsonb) AS fact(value)`;
}

const STRENGTH_RANK_SQL = (strength: SQL) => sql`CASE (${strength})::text
  WHEN ${"strong"} THEN ${STRENGTH_RANK.strong}::int
  WHEN ${"medium"} THEN ${STRENGTH_RANK.medium}::int
  WHEN ${"weak"} THEN ${STRENGTH_RANK.weak}::int END`;

function familyFactSelect(
  family: SuggestionListFamily,
  query: SuggestionFactQuery,
  needs: ReadonlySet<string>,
) {
  const columns = FACT_COLUMNS.map((name) => {
    if (name === "id") return typedFact(name, sql`s.id`);
    if (name === "family") return typedFact(name, sql`${family}`);
    if (!needs.has(name)) return typedFact(name, sql`NULL`);
    if (name === "strengthRank")
      return typedFact(name, STRENGTH_RANK_SQL(query.columns.strength!));
    return typedFact(name, query.columns[name] ?? sql`NULL`);
  });
  return sql`SELECT ${sql.join(columns, sql`, `)} FROM ${query.from} WHERE ${query.where}`;
}

function factRelation(parts: readonly SQL[]) {
  const union = parts.length
    ? sql.join(
        parts.map((part) => sql`(${part})`),
        sql` UNION ALL `,
      )
    : sql`SELECT ${sql.join(
        FACT_COLUMNS.map((name) => typedFact(name, sql`NULL`)),
        sql`, `,
      )} WHERE false`;
  return sql`(${union}) AS suggestion_facts`;
}

const relationColumn = (name: string) =>
  sql`${sql.identifier("suggestion_facts")}.${sql.identifier(name)}`;

function predicates(filters: SuggestionListFilters) {
  return compileDeclaredFilters(
    {
      label: "Suggestions",
      descriptors: suggestionFilterDeclaration.descriptors.map(
        (descriptor) => ({
          ...descriptor,
          stored: {
            ...descriptor.stored,
            array: ARRAY_COLUMNS.has(descriptor.columnId),
          },
        }),
      ),
      column: (_descriptor, name) => ({
        column: relationColumn(name),
        value: relationColumn(name),
        kind: ARRAY_COLUMNS.has(name)
          ? "text-array"
          : NUMBER_COLUMNS.has(name)
            ? "number"
            : name === "date"
              ? "date"
              : "text",
        nullable: true,
        reference: null,
      }),
    },
    filters,
  );
}

/** Which fact columns a filter set and an order read; the rest stay unjoined. */
function factNeeds(
  filters: SuggestionListFilters,
  order: readonly SortTerm[] = [],
  extra: readonly string[] = [],
) {
  const values = new Map(Object.entries(filters));
  const needs = new Set(extra);
  for (const column of [
    ...suggestionFilterDeclaration.filters.map((filter) => filter.columnId),
    "month",
  ])
    if (
      values.get(column) !== undefined ||
      values.get(`${column}Exclude`) !== undefined ||
      values.get(`${column}Presence`) !== undefined ||
      values.get(`${column}From`) !== undefined ||
      values.get(`${column}To`) !== undefined
    )
      needs.add(column);
  for (const name of order.flatMap((term) => sortColumns(term.by))) {
    needs.add(name === "strengthRank" ? "strength" : name);
    needs.add(name);
  }
  return needs;
}

function sortColumns(by: string) {
  const ready = ["clean", "strengthRank", "createdAt"];
  return by === "ready"
    ? ready
    : by === "impact"
      ? ["impact", ...ready]
      : [by === "strength" ? "strengthRank" : by];
}

/**
 * The fact relation for one read. Large families project from Suggestion columns;
 * small ones reuse their keys. Family hydration revalidates only paged rows, so
 * a count may include a row whose evidence has since gone stale.
 */
async function preparedFacts(
  db: Database,
  filters: SuggestionListFilters,
  needs: ReadonlySet<string>,
  cleanOnly = false,
) {
  const { families, touching, matchedFamilies, familyScope } =
    await scopedFamilyQuery(db, filters, cleanOnly);
  const selected = families.filter(
    (family) =>
      family === "field" ||
      family === "recommendation" ||
      !matchedFamilies ||
      matchedFamilies.has(family),
  );
  const keyed: SuggestionKey[] = [];
  const parts: SQL[] = [];
  for (const family of selected) {
    const presentation = suggestionFamilies[family];
    if ("facts" in presentation && presentation.facts) {
      const query = presentation.facts(familyScope, needs);
      if (query) parts.push(familyFactSelect(family, query, needs));
      continue;
    }
    if (!presentation.keys) continue;
    keyed.push(
      ...(
        await presentation.keys(
          db,
          family === "field" || family === "recommendation"
            ? {
                ...familyScope,
                suggestionIds: undefined,
              }
            : familyScope,
        )
      ).filter(
        (key) =>
          (filters.status !== "pending" || key.automaticRule === null) &&
          (key.family === "field" ||
            key.family === "recommendation" ||
            !touching ||
            touching.has(key.suggestionId)),
      ),
    );
  }
  if (keyed.length) parts.push(keysFactSelect(keyed));
  return { families, relation: factRelation(parts), familyScope };
}

function selectFacts(
  db: Database,
  relation: SQL,
  filters: SuggestionListFilters | undefined,
  order: readonly SortTerm[],
  paging: {
    limit: number;
    offset: number;
    cursor?: ReturnType<typeof suggestionCursor.decode>;
  },
  extra: readonly (SQL | undefined)[] = [],
) {
  const terms = order.flatMap((term) =>
    sortColumns(term.by).map((name) => ({
      ...term,
      name,
      value: ARRAY_COLUMNS.has(name)
        ? sql`(${relationColumn(name)})[1]`
        : relationColumn(name),
    })),
  );
  terms.push({
    by: "id",
    name: "id",
    value: relationColumn("id"),
    direction: "asc",
  });
  const cursor = paging.cursor;
  const equal: SQL[] = [];
  const after = cursor
    ? or(
        ...terms.map((term, index) => {
          const value =
            index === terms.length - 1
              ? cursor.id
              : (cursor.vector[index] ?? null);
          const next =
            value === null
              ? undefined
              : or(
                  isNull(term.value),
                  (term.direction === "asc" ? gt : lt)(term.value, value),
                );
          const branch = next ? and(...equal, next) : undefined;
          equal.push(
            value === null ? isNull(term.value) : eq(term.value, value),
          );
          return branch;
        }),
      )
    : undefined;
  return getDb(db)
    .select({
      id: sql<string>`${relationColumn("id")}`,
      family: sql<SuggestionListFamily>`${relationColumn("family")}`,
      vector: sql<SuggestionColumnValue[]>`jsonb_build_array(${sql.join(
        terms.slice(0, -1).map((term) => term.value),
        sql`, `,
      )})`.as("vector"),
    })
    .from(relation)
    .where(and(...(filters ? predicates(filters) : []), after, ...extra))
    .orderBy(
      ...terms.map(
        (term) =>
          sql`${term.direction === "asc" ? asc(term.value) : desc(term.value)} NULLS LAST`,
      ),
    )
    .limit(paging.limit)
    .offset(cursor ? 0 : paging.offset);
}

/** Reads each paged row's family key and hydrated evidence, dropping stale rows. */
async function pagedRows(
  db: Database,
  entries: readonly { id: string; family: SuggestionListFamily }[],
  filters: SuggestionListFilters,
) {
  const byFamily = new Map<SuggestionListFamily, string[]>();
  for (const entry of entries)
    byFamily.set(entry.family, [
      ...(byFamily.get(entry.family) ?? []),
      entry.id,
    ]);
  const pages = [];
  for (const [family, ids] of byFamily) {
    const pageRows = suggestionFamilies[family].pageRows;
    if (!pageRows) continue;
    pages.push(await pageRows(db, ids, filters));
    byFamily.delete(family);
  }
  const keys = (
    await Promise.all(
      [...byFamily].map(([family, suggestionIds]) =>
        suggestionFamilies[family].keys?.(db, {
          filters: {
            ...filters,
            recordEntity: undefined,
            recordIds: undefined,
          },
          suggestionIds,
        }),
      ),
    )
  )
    .flatMap((group) => group ?? [])
    .filter(
      (key) => filters.status !== "pending" || key.automaticRule === null,
    );
  return new Map([
    ...pages.flatMap((page) => [...page]),
    ...(await hydrate(db, keys)),
  ]);
}

async function familyQuery(
  db: Database,
  filters: SuggestionListFilters,
): Promise<SuggestionFamilyQuery> {
  if (!filters.recordIds) return { filters };
  const refs = await resolveShortcodes(db, filters.recordIds);
  return {
    filters,
    records: [...refs].map(([code, ref]) => ({
      code,
      entity: ref.entity,
      id: ref.id,
    })),
  };
}

const familiesOf = (filters: SuggestionListFilters) =>
  filters.family ? [filters.family] : suggestionListFamily.options;

async function scopedFamilyQuery(
  db: Database,
  filters: SuggestionListFilters,
  cleanOnly = false,
) {
  const families = familiesOf(filters).filter(
    (family) =>
      !cleanOnly || (family !== "field" && family !== "recommendation"),
  );
  const query = await familyQuery(db, filters);
  const storedFamilies = families.filter(
    (family) => family !== "field" && family !== "recommendation",
  );
  const matched = storedFamilies.length
    ? await touchingSuggestionFamilies(db, {
        entity: filters.recordEntity,
        records: query.records,
        eligibility: {
          kind: "suggestions",
          families: storedFamilies,
          status: filters.status,
          runCode: filters.runId,
        },
      })
    : null;
  const touching = matched ? new Set(matched.keys()) : null;
  const matchedFamilies = matched
    ? new Set([...matched.values()].flat())
    : null;
  const familyScope = {
    filters: query.filters,
    records: query.records,
    suggestionIds: touching ? [...touching] : undefined,
  };
  return {
    families,
    touching,
    matchedFamilies,
    familyScope,
    records: query.records,
  };
}

async function hydrate(
  db: Database,
  keys: readonly SuggestionKey[],
): Promise<Map<string, SuggestionListRow>> {
  const byFamily = new Map<SuggestionListFamily, SuggestionKey[]>();
  for (const key of keys)
    byFamily.set(key.family, [...(byFamily.get(key.family) ?? []), key]);
  const maps = await Promise.all(
    [...byFamily].map(([family, familyKeys]) =>
      suggestionFamilies[family].rows?.(db, familyKeys),
    ),
  );
  return new Map<string, SuggestionListRow>(
    maps.flatMap((map) => (map ? [...map] : [])),
  );
}

/** One SQL-filtered, ordered page of pending family rows. */
export async function listSuggestionPage(
  db: Database,
  raw: z.input<typeof suggestionListInput>,
) {
  const input = suggestionListInput.parse(raw);
  const filters = input;
  const requested = suggestionFilterDeclaration.sortsOf(input.sort);
  const order: SortTerm[] = requested.map((sort) => ({
    by: sort.orderBy,
    direction: sort.direction,
  }));
  const orderKey = JSON.stringify(order);
  const cursor = input.cursor
    ? suggestionCursor.decode(input.cursor)
    : undefined;
  if (cursor && cursor.order !== orderKey)
    throw new Error(
      "Cursor was issued for another order; restart without a cursor",
    );
  const needs = factNeeds(filters, order, ["clean"]);
  const { relation } = await preparedFacts(db, filters, needs);
  const pageQuery = selectFacts(db, sql`suggestion_facts`, undefined, order, {
    limit: input.limit + 1,
    offset: input.offset,
    cursor,
  });
  const result = await unwrapDb(db).execute<{
    entries: {
      id: string;
      family: SuggestionListFamily;
      vector: SuggestionColumnValue[];
    }[];
    total: number;
    clean: number;
  }>(sql`
    WITH suggestion_facts AS MATERIALIZED (
      SELECT * FROM ${relation} WHERE ${and(...predicates(filters)) ?? sql`true`}
    )
    SELECT (SELECT coalesce(jsonb_agg(page), '[]'::jsonb) FROM (${pageQuery.getSQL()}) page) AS entries,
      count(*)::int AS total,
      count(*) FILTER (WHERE clean = 'true')::int AS clean
    FROM suggestion_facts
  `);
  const totals = result.rows[0];
  const entries = totals?.entries ?? [];
  const more = entries.length > input.limit;
  const page = entries.slice(0, input.limit);
  const last = page.at(-1);
  const rows = await pagedRows(db, page, filters);
  return suggestionListOut.parse({
    items: page.flatMap((entry) => {
      const row = rows.get(entry.id);
      return row ? [row] : [];
    }),
    meta: {
      pageIndex: Math.floor(input.offset / input.limit),
      pageSize: input.limit,
      totalCount: totals?.total ?? 0,
      cleanCount: totals?.clean ?? 0,
    },
    next:
      more && last
        ? suggestionCursor.encode({
            order: orderKey,
            vector: last.vector,
            id: last.id,
          })
        : null,
  });
}

/** Per-family counts; pending, clean and Strength follow every filter. */
export async function suggestionCountsByFamily(
  db: Database,
  raw: z.input<typeof suggestionCountsInput> = {},
) {
  const filters: SuggestionListFilters = {
    ...suggestionCountsInput.parse(raw),
    status: "pending" as const,
  };
  const { families, relation, familyScope } = await preparedFacts(
    db,
    filters,
    factNeeds(filters, [], ["clean", "strength", "entity", "field"]),
  );
  const familyColumn = relationColumn("family");
  const fieldFamily = sqlEnumConstant(suggestionListFamily, "field");
  const fieldEntity = sql<
    string | null
  >`CASE WHEN ${familyColumn} = ${fieldFamily} THEN ${relationColumn("entity")} END`;
  const fieldName = sql<
    string | null
  >`CASE WHEN ${familyColumn} = ${fieldFamily} THEN ${relationColumn("field")} END`;
  const strengthCount = (strength: SuggestionStrength) =>
    sql<number>`count(*) FILTER (WHERE ${relationColumn("strength")} = ${strength})::int`;
  const pendingRows = await getDb(db)
    .select({
      family: sql<SuggestionListFamily>`${familyColumn}`,
      entity: fieldEntity,
      field: fieldName,
      pending: sql<number>`count(*)::int`,
      clean: sql<number>`count(*) FILTER (WHERE ${relationColumn("clean")} = 'true')::int`,
      strong: strengthCount("strong"),
      medium: strengthCount("medium"),
      weak: strengthCount("weak"),
    })
    .from(relation)
    .where(and(...predicates(filters)))
    .groupBy(familyColumn, fieldEntity, fieldName);
  const pendingByFamily = new Map<
    SuggestionListFamily,
    ReturnType<typeof emptyPendingCounts>
  >();
  const fieldRows = new Map<
    string,
    { entity: string; field: string; pending: number }
  >();
  for (const row of pendingRows) {
    const counts = pendingByFamily.get(row.family) ?? emptyPendingCounts();
    counts.pending += row.pending;
    counts.clean += row.clean;
    counts.strong += row.strong;
    counts.medium += row.medium;
    counts.weak += row.weak;
    pendingByFamily.set(row.family, counts);
    if (row.family === "field" && row.entity && row.field)
      fieldRows.set(`${row.entity}:${row.field}`, {
        entity: row.entity,
        field: row.field,
        pending: row.pending,
      });
  }
  const counts = await Promise.all(
    families.map(async (family) => {
      const outcomes = await suggestionFamilies[family].outcomes(
        db,
        filters,
        familyScope.records,
      );
      const fields = new Map(
        outcomes.fields.map((field) => [
          `${field.entity}:${field.field}`,
          field,
        ]),
      );
      if (family === "field")
        for (const [key, field] of fieldRows) {
          const existing = fields.get(key);
          fields.set(
            key,
            existing
              ? { ...existing, pending: field.pending }
              : {
                  ...field,
                  applied: 0,
                  rejected: 0,
                  superseded: 0,
                  resolved: 0,
                },
          );
        }
      return {
        family,
        ...(pendingByFamily.get(family) ?? emptyPendingCounts()),
        ...outcomes,
        fields: [...fields.values()].sort(
          (a, b) =>
            a.entity.localeCompare(b.entity) || a.field.localeCompare(b.field),
        ),
      };
    }),
  );
  return suggestionCountsOut.parse({
    families: counts,
  });
}

const acceptAsIs = (row: SuggestionListRow) => {
  // SAFETY: the row discriminant selects the declaration for that exact row family.
  return suggestionFamilies[row.family].acceptAsIs(row as never);
};

/**
 * Accepts up to `limit` clean Suggestions as recommended. The clean set is
 * re-listed here rather than taken from the caller, and each item carries the
 * fingerprint it was listed under, so a Suggestion republished in between
 * (new evidence, maybe no longer clean) is refused rather than applied.
 */
export async function acceptCleanSuggestions(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof acceptCleanSuggestionsInput>,
) {
  const input = acceptCleanSuggestionsInput.parse(raw);
  const filters = { ...input.filters, status: "pending" as const };
  const order: SortTerm[] = [{ by: "ready", direction: "desc" }];
  const { relation } = await preparedFacts(
    db,
    filters,
    factNeeds(filters, order),
    true,
  );
  const entries = await selectFacts(
    db,
    relation,
    filters,
    order,
    { limit: input.limit, offset: 0 },
    [
      sql`${relationColumn("clean")} = 'true'`,
      input.skip.length
        ? notInArray(relationColumn("id"), input.skip)
        : undefined,
    ],
  );
  const hydrated = await pagedRows(db, entries, filters);
  const rows = entries.flatMap((entry) => {
    const row = hydrated.get(entry.id);
    return row ? [row] : [];
  });
  const results: z.infer<typeof acceptCleanSuggestionsOut> = [];
  const settledPairs = new Set<string>();
  for (const row of rows) {
    // SAFETY: the row discriminant selects the matching family's callback.
    const pairKey =
      suggestionFamilies[row.family].pairKey?.(row as never) ?? null;
    if (pairKey && settledPairs.has(pairKey)) {
      results.push({
        suggestionId: row.suggestionId,
        ok: true,
        applied: false,
        status: "settled_by_pair",
        reason: "The same transfer pair was accepted earlier in this batch.",
      });
      continue;
    }
    const item = acceptAsIs(row);
    if (!item) {
      results.push({
        suggestionId: row.suggestionId,
        ok: false,
        error: "No longer clean under the current rules; review it on its own.",
      });
      continue;
    }
    const [result] = await reviewSuggestionBatch(db, context, {
      items: [item],
    });
    if (result) {
      results.push(result);
      if (result.ok && result.applied && pairKey) settledPairs.add(pairKey);
    }
  }
  return results;
}

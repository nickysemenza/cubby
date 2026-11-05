import type {
  AssessmentReadFilterFacts,
  AssessmentReadDependency,
  AssessmentReadMembership,
} from "@cubby/schemas/assessment-read-publication";
import { assessmentReadCoverage } from "@cubby/schemas/assessment-read-publication";
import {
  suggestionRecordCountsInput,
  suggestionRecordCountsOut,
} from "@cubby/schemas/automatic-decision";
import {
  acceptCleanSuggestionsInput,
  type acceptCleanSuggestionsOut,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionFamilyCount,
  suggestionFieldCount,
  suggestionGroup,
  suggestionListFamily,
  suggestionListFilters,
  suggestionListInput,
  suggestionListOut,
  suggestionListRow,
  suggestionStrength,
  type SuggestionColumnValue,
  type SuggestionGroup,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListRow,
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
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentReadPublication } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { reviewAssessmentBatch } from "~/server/generic/assessment/repo/assessment-review";
import {
  publishedAssessmentRecordRefsSql,
  publishedAssessmentCoverageSql,
  publishedAssessmentAdmissionSql,
} from "~/server/generic/assessment/repo/read-publication";
import {
  type SuggestionFamilyQuery,
  type SuggestionKey,
  type SuggestionReadObserver,
  emptyPendingCounts,
  suggestionFamilies,
} from "~/server/generic/assessment/repo/suggestion-families";
import { compileDeclaredFilters } from "~/server/generic/list/repo/declared-filters";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  readAssessmentReadMemberships,
  touchingAssessmentFamilies,
} from "./review-families";

const STRENGTH_RANK = { strong: 2, medium: 1, weak: 0 } as const;
const ARRAY_COLUMNS = new Set(["account", "owner", "entityKind", "merchant"]);
const recordCountFields =
  suggestionRecordCountsOut.shape.records.element.keyof().enum;
const NUMBER_COLUMNS = new Set([
  "amount",
  "confidence",
  "dateGapDays",
  "impact",
]);

const cursorSchema = z.object({
  order: z.string(),
  vector: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  id: z.string(),
});

type SortTerm = { by: string; direction: "asc" | "desc" };

/**
 * Family eligibility owns current evidence and its derived facts. Project that
 * validated fact stream as a relation; the shared compiler is the only owner
 * of filter operators, and PostgreSQL owns ordering and paging.
 */
export function suggestionKeyFacts(
  key: SuggestionKey,
): AssessmentReadFilterFacts {
  return {
    id: key.assessmentId,
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
    // The UI's confidence bounds are percentages, as its cells are.
    confidence:
      typeof key.columns.confidence === "number"
        ? key.columns.confidence * 100
        : null,
  };
}

function factRelation(db: Database, source: SQL) {
  const names = new Set([
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
  ]);
  const fields = Object.fromEntries(
    [...names].map((name) => {
      const text = sql`fact.value->>${name}`;
      const value = ARRAY_COLUMNS.has(name)
        ? sql`ARRAY(SELECT jsonb_array_elements_text(fact.value->${name}))`
        : NUMBER_COLUMNS.has(name) || name === "strengthRank"
          ? sql`(${text})::numeric`
          : text;
      return [name, value.as(name)];
    }),
  );
  return getDb(db).select(fields).from(source).as("suggestion_facts");
}

function keyRelation(db: Database, keys: readonly SuggestionKey[]) {
  return factRelation(
    db,
    sql`jsonb_array_elements(${JSON.stringify(keys.map(suggestionKeyFacts))}::jsonb) AS fact(value)`,
  );
}

async function publishedKeyRelation(
  db: Database,
  filters: SuggestionListFilters,
) {
  const query = await familyQuery(db, filters);
  return factRelation(
    db,
    sql`(${publishedAssessmentAdmissionSql({
      entity: filters.recordEntity,
      records: query.records,
      families: familiesOf(filters),
    })}) publication CROSS JOIN LATERAL (SELECT publication.filters AS value) fact
    ${
      filters.runId
        ? sql`WHERE publication."assessmentId" IN (
      SELECT id FROM "AssessmentState" WHERE "runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runId})
    )`
        : sql``
    }`,
  );
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

function selectKeyQuery(
  db: Database,
  relation: ReturnType<typeof factRelation>,
  filters: SuggestionListFilters,
  order: readonly SortTerm[] = [],
  paging?: {
    limit: number;
    offset: number;
    cursor?: z.infer<typeof cursorSchema>;
  },
  gate?: SQL,
) {
  const terms = order.flatMap((term) => {
    const ready = ["clean", "strengthRank", "createdAt"];
    const names =
      term.by === "ready"
        ? ready
        : term.by === "impact"
          ? ["impact", ...ready]
          : [term.by === "strength" ? "strengthRank" : term.by];
    return names.map((name) => ({
      ...term,
      name,
      value: ARRAY_COLUMNS.has(name)
        ? sql`(${relationColumn(name)})[1]`
        : relationColumn(name),
    }));
  });
  terms.push({
    by: "id",
    name: "id",
    value: relationColumn("id"),
    direction: "asc",
  });
  const cursor = paging?.cursor;
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
  const query = getDb(db)
    .select({
      id: sql<string>`${relationColumn("id")}`.as("id"),
      family: sql<SuggestionListFamily>`${relationColumn("family")}`.as(
        "family",
      ),
      position: sql<number>`row_number() OVER (ORDER BY ${sql.join(
        terms.map(
          (term) =>
            sql`${term.direction === "asc" ? asc(term.value) : desc(term.value)} NULLS LAST`,
        ),
        sql`, `,
      )})`.as("position"),
      vector: sql<SuggestionColumnValue[]>`jsonb_build_array(${sql.join(
        terms.slice(0, -1).map((term) => term.value),
        sql`, `,
      )})`.as("vector"),
    })
    .from(relation)
    .where(and(...predicates(filters), after, gate))
    .orderBy(
      ...terms.map(
        (term) =>
          sql`${term.direction === "asc" ? asc(term.value) : desc(term.value)} NULLS LAST`,
      ),
    );
  return paging
    ? query.limit(paging.limit).offset(cursor ? 0 : paging.offset)
    : query;
}

async function selectKeys(
  db: Database,
  keys: readonly SuggestionKey[],
  filters: SuggestionListFilters,
  order: readonly SortTerm[] = [],
  paging?: Parameters<typeof selectKeyQuery>[4],
) {
  const selected = await selectKeyQuery(
    db,
    keyRelation(db, keys),
    filters,
    order,
    paging,
  );
  const byId = new Map(keys.map((key) => [key.assessmentId, key]));
  return selected.flatMap((row) => {
    const key = byId.get(row.id);
    return key ? [{ key, id: row.id, vector: row.vector }] : [];
  });
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

async function scopedFamilyQuery(db: Database, filters: SuggestionListFilters) {
  const families = familiesOf(filters);
  const query = await familyQuery(db, filters);
  const matched = await touchingAssessmentFamilies(db, {
    entity: filters.recordEntity,
    records: query.records,
    eligibility: {
      kind: "suggestions",
      families,
      status: filters.status,
      runCode: filters.runId,
    },
  });
  const touching = matched ? new Set(matched.keys()) : null;
  const matchedFamilies = matched
    ? new Set([...matched.values()].flat())
    : null;
  const familyScope = {
    filters: {
      ...query.filters,
      recordEntity: undefined,
      recordIds: undefined,
    },
    assessmentIds: touching ? [...touching] : undefined,
  };
  return { families, touching, matchedFamilies, familyScope };
}

async function currentCandidates(
  db: Database,
  filters: SuggestionListFilters,
  prepared?: Awaited<ReturnType<typeof scopedFamilyQuery>>,
  observeInputs?: SuggestionReadObserver,
) {
  const { families, touching, matchedFamilies, familyScope } =
    prepared ?? (await scopedFamilyQuery(db, filters));
  if (touching?.size === 0)
    return { families, keys: [], rows: new Map<string, SuggestionListRow>() };
  const keys = (
    await Promise.all(
      families
        .filter((family) => !matchedFamilies || matchedFamilies.has(family))
        .map((family) =>
          suggestionFamilies[family].keys(db, familyScope, observeInputs),
        ),
    )
  )
    .flat()
    .filter(
      (key) =>
        (filters.status !== "pending" || key.automaticRule === null) &&
        (!touching || touching.has(key.assessmentId)),
    );
  // Admission must precede both counting and paging. Family hydration owns
  // freshness checks that cannot be inferred from a stored pending status.
  const rows = await hydrate(db, keys, observeInputs);
  const current = keys.filter((key) => rows.has(key.assessmentId));
  return { families, keys: current, rows };
}

/** Background publication and live actions use the same family admission owner. */
export async function prepareSuggestionAdmission(
  db: Database,
  assessmentIds: readonly string[],
): Promise<{
  keys: SuggestionKey[];
  rows: Map<string, SuggestionListRow>;
  /** Only observed read sets are present; a missing entry must not be treated as complete. */
  dependencies: Map<string, AssessmentReadDependency[]>;
  memberships: Map<string, AssessmentReadMembership[]>;
}> {
  const filters = suggestionListFilters.parse({});
  const identities = [...new Set(assessmentIds)];
  const dependencies = new Map<string, AssessmentReadDependency[]>();
  const observeInputs: SuggestionReadObserver = (id, sources) => {
    const unique = new Map(
      (dependencies.get(id) ?? []).map((source) => [
        JSON.stringify([source.sourceKind, source.sourceId]),
        source,
      ]),
    );
    for (const source of sources)
      unique.set(JSON.stringify([source.sourceKind, source.sourceId]), source);
    dependencies.set(
      id,
      [...unique]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, source]) => source),
    );
  };
  const admitted = await currentCandidates(
    db,
    filters,
    {
      families: familiesOf(filters),
      touching: new Set(identities),
      matchedFamilies: null,
      familyScope: {
        filters: { ...filters, recordEntity: undefined, recordIds: undefined },
        assessmentIds: identities,
      },
    },
    observeInputs,
  );
  const memberships = await readAssessmentReadMemberships(
    db,
    identities,
    observeInputs,
  );
  return {
    keys: admitted.keys,
    rows: admitted.rows,
    dependencies,
    memberships,
  };
}

async function scopedKeys(
  db: Database,
  filters: SuggestionListFilters,
  prepared?: Awaited<ReturnType<typeof scopedFamilyQuery>>,
) {
  const candidates = await currentCandidates(db, filters, prepared);
  return {
    ...candidates,
    all: candidates.keys,
    keys: candidates.keys.length
      ? (await selectKeys(db, candidates.keys, filters)).map(
          (entry) => entry.key,
        )
      : [],
  };
}

/** Counts use the queue's eligibility and declared subjects, including either endpoint. */
export async function suggestionRecordCounts(
  db: Database,
  raw: z.input<typeof suggestionRecordCountsInput>,
) {
  const input = suggestionRecordCountsInput.parse(raw);
  if (!input.recordIds.length)
    return suggestionRecordCountsOut.parse({
      records: [],
      coverage: {
        missing: false,
        stale: false,
        unresolved: false,
        failed: false,
      },
    });
  const query = await familyQuery(
    db,
    suggestionListFilters.parse({ recordIds: input.recordIds }),
  );
  // Discovery spans the whole requested batch before resolved references are
  // counted. Duplicate membership ordinals retain the canonical count semantics.
  const result = await getDb(db).execute(sql`
    WITH counts AS (
      SELECT "recordCode", count(*)::int AS pending
      FROM (${publishedAssessmentRecordRefsSql({ records: query.records })}) refs
      GROUP BY "recordCode"
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      ${recordCountFields.id}::text, requested.id, ${recordCountFields.pending}::text, coalesce(counts.pending, 0)
    ) ORDER BY requested.ordinal), '[]'::jsonb) AS records,
      (SELECT to_jsonb(coverage) FROM (${publishedAssessmentCoverageSql()}) coverage) AS coverage
    FROM jsonb_to_recordset(${JSON.stringify(
      [...new Set(input.recordIds)].map((id, ordinal) => ({ id, ordinal })),
    )}::jsonb) requested(id text, ordinal int)
    LEFT JOIN counts ON counts."recordCode" = requested.id`);
  return suggestionRecordCountsOut.parse(result.rows[0]);
}

async function hydrate(
  db: Database,
  keys: readonly SuggestionKey[],
  observeInputs?: SuggestionReadObserver,
): Promise<Map<string, SuggestionListRow>> {
  const byFamily = new Map<SuggestionListFamily, SuggestionKey[]>();
  for (const key of keys)
    byFamily.set(key.family, [...(byFamily.get(key.family) ?? []), key]);
  const maps: Map<string, SuggestionListRow>[] = await Promise.all(
    [...byFamily].map(([family, familyKeys]) =>
      suggestionFamilies[family].rows(db, familyKeys, observeInputs),
    ),
  );
  return new Map(maps.flatMap((map) => [...map]));
}

const GROUP_ACTIONS = ["create", "attach", "supersede", "void"] as const;

/** Account × month sections of the ordered statement keys, in page order. */
function statementGroups(keys: readonly SuggestionKey[]): SuggestionGroup[] {
  type Draft = Omit<SuggestionGroup, "accountId" | "ownerId"> & {
    accountId: string;
    ownerId: unknown;
  };
  const groups = new Map<string, Draft>();
  for (const key of keys) {
    const month = String(key.columns.month);
    const accountId = String(key.columns.account);
    const groupKey = `${accountId}|${month}`;
    const group = groups.get(groupKey) ?? {
      key: groupKey,
      label: month,
      count: 0,
      clean: 0,
      create: 0,
      attach: 0,
      supersede: 0,
      void: 0,
      amount: 0,
      accountId,
      ownerId: key.columns.owner ?? null,
      month,
    };
    group.count += 1;
    if (key.clean) group.clean += 1;
    const action = GROUP_ACTIONS.find((name) => name === key.columns.action);
    if (action) group[action] += 1;
    group.amount += Number(key.columns.amount ?? 0);
    groups.set(groupKey, group);
  }
  return suggestionGroup.array().parse([...groups.values()]);
}

/** One SQL-filtered, ordered page of currently reviewable family facts. */
async function listPublishedSuggestionPage(
  db: Database,
  input: z.infer<typeof suggestionListInput>,
  filters: SuggestionListFilters,
  order: readonly SortTerm[],
  orderKey: string,
  cursor: z.infer<typeof cursorSchema> | undefined,
) {
  const relation = await publishedKeyRelation(db, filters);
  const selected = selectKeyQuery(db, relation, filters, order, {
    ...input,
    cursor,
    limit: input.limit + 1,
  });
  const totals = getDb(db)
    .select({
      totalCount: sql<number>`count(*)::int`.as("totalCount"),
      cleanCount:
        sql<number>`count(*) FILTER (WHERE ${relationColumn("clean")} = ${String(true)})::int`.as(
          "cleanCount",
        ),
    })
    .from(relation)
    .where(and(...predicates(filters)));
  const groupFacts =
    input.group === "account_month"
      ? getDb(db)
          .select({
            key: sql<string>`(${relationColumn("account")})[1] || '|' || ${relationColumn("month")}`.as(
              "key",
            ),
            label: relationColumn("month").as("label"),
            month: relationColumn("month").as("month"),
            accountId: sql`(${relationColumn("account")})[1]`.as("accountId"),
            ownerId: sql`(${relationColumn("owner")})[1]`.as("ownerId"),
            count: sql`count(*)::int`.as("count"),
            clean:
              sql`count(*) FILTER (WHERE ${relationColumn("clean")} = ${String(true)})::int`.as(
                "clean",
              ),
            ...Object.fromEntries(
              GROUP_ACTIONS.map((action) => [
                action,
                sql`count(*) FILTER (WHERE ${relationColumn("action")} = ${action})::int`.as(
                  action,
                ),
              ]),
            ),
            amount: sql`coalesce(sum(${relationColumn("amount")}), 0)`.as(
              "amount",
            ),
          })
          .from(relation)
          .where(and(...predicates(filters)))
          .groupBy(
            relationColumn("month"),
            relationColumn("account"),
            relationColumn("owner"),
          )
          .orderBy(
            desc(relationColumn("month")),
            asc(relationColumn("account")),
          )
      : sql`SELECT NULL WHERE false`;
  // Totals, page payloads and coverage share one statement snapshot. Payloads
  // are loaded only after indexed admission, filtering and page selection.
  const result = await getDb(db).execute(sql`
    WITH selected AS MATERIALIZED (${selected}),
    page AS (
      SELECT selected.id, selected.vector, selected.position, p.row
      FROM selected JOIN ${assessmentReadPublication} p
        ON p."assessmentId" = selected.id::uuid AND p.family = selected.family AND p.active
      ORDER BY selected.position LIMIT ${input.limit}
    )
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY position) FROM page), '[]'::jsonb) AS records,
      totals."totalCount", totals."cleanCount",
      (SELECT count(*) > ${input.limit} FROM selected) AS more,
      ${input.group === "account_month" ? sql`(SELECT coalesce(jsonb_agg(to_jsonb(groups)), '[]'::jsonb) FROM (${groupFacts}) groups)` : sql`NULL::jsonb`} AS groups,
      (SELECT to_jsonb(coverage) FROM (${publishedAssessmentCoverageSql()}) coverage) AS coverage
    FROM (${totals}) totals`);
  const page = z
    .object({
      records: z.array(
        z.object({
          id: z.string(),
          vector: cursorSchema.shape.vector,
          row: suggestionListRow,
        }),
      ),
      totalCount: z.number().int(),
      cleanCount: z.number().int(),
      more: z.boolean(),
      groups: z.array(suggestionGroup).nullable(),
      coverage: assessmentReadCoverage,
    })
    .parse(result.rows[0]);
  const last = page.records.at(-1);
  return suggestionListOut.parse({
    items: page.records.map(({ row }) => row),
    meta: {
      pageIndex: Math.floor(input.offset / input.limit),
      pageSize: input.limit,
      totalCount: page.totalCount,
      cleanCount: page.cleanCount,
      coverage: page.coverage,
      ...(page.groups ? { groups: page.groups } : {}),
    },
    next:
      page.more && last
        ? Buffer.from(
            JSON.stringify({
              order: orderKey,
              vector: last.vector,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  });
}

export async function listSuggestionPage(
  db: Database,
  raw: z.input<typeof suggestionListInput>,
) {
  const input = suggestionListInput.parse(raw);
  const grouped = input.group === "account_month";
  const filters = grouped
    ? { ...input, family: "statement_transaction" as const }
    : input;
  const requested = suggestionFilterDeclaration.sortsOf(input.sort);
  const order: SortTerm[] = [
    ...(grouped
      ? [
          { by: "month", direction: "desc" as const },
          { by: "account", direction: "asc" as const },
        ]
      : []),
    ...requested.map((sort) => ({
      by: sort.orderBy,
      direction: sort.direction,
    })),
  ];
  const orderKey = JSON.stringify(order);
  const cursor = input.cursor
    ? cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      )
    : undefined;
  if (cursor && cursor.order !== orderKey)
    throw new Error(
      "Cursor was issued for another order; restart without a cursor",
    );
  if (input.status === "pending")
    return listPublishedSuggestionPage(
      db,
      input,
      filters,
      order,
      orderKey,
      cursor,
    );
  const {
    keys,
    all,
    rows = new Map<string, SuggestionListRow>(),
  } = await scopedKeys(db, filters);
  const entries = await selectKeys(db, all, filters, order, {
    ...input,
    cursor,
    limit: input.limit + 1,
  });
  const more = entries.length > input.limit;
  const page = entries.slice(0, input.limit);
  const last = page.at(-1);
  const clean = keys.filter((key) => key.clean).length;
  return suggestionListOut.parse({
    items: page.flatMap((entry) => {
      const row = rows.get(entry.id);
      return row ? [row] : [];
    }),
    meta: {
      pageIndex: Math.floor(input.offset / input.limit),
      pageSize: input.limit,
      totalCount: keys.length,
      cleanCount: clean,
      ...(grouped
        ? {
            groups: statementGroups(
              (await selectKeys(db, all, filters, order)).map(
                (entry) => entry.key,
              ),
            ),
          }
        : {}),
    },
    next:
      more && last
        ? Buffer.from(
            JSON.stringify({
              order: orderKey,
              vector: last.vector,
              id: last.id,
            }),
          ).toString("base64url")
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
  const families = familiesOf(filters);
  const relation = await publishedKeyRelation(db, filters);
  const pendingQuery = getDb(db)
    .select({
      family: relationColumn("family").as("family"),
      pending: sql`count(*)::int`.as("pending"),
      clean:
        sql`count(*) FILTER (WHERE ${relationColumn("clean")} = ${String(true)})::int`.as(
          "clean",
        ),
      ...Object.fromEntries(
        suggestionStrength.options.map((strength) => [
          strength,
          sql`count(*) FILTER (WHERE ${relationColumn("strength")} = ${strength})::int`.as(
            strength,
          ),
        ]),
      ),
    })
    .from(relation)
    .where(and(...predicates(filters)))
    .groupBy(relationColumn("family"));
  const fieldQuery = getDb(db)
    .select({
      entity: relationColumn("entity").as("entity"),
      field: relationColumn("field").as("field"),
      pending: sql`count(*)::int`.as("pending"),
    })
    .from(relation)
    .where(and(...predicates(filters), eq(relationColumn("family"), "field")))
    .groupBy(relationColumn("entity"), relationColumn("field"));
  const pendingResult = await getDb(db).execute(sql`SELECT
    coalesce((SELECT jsonb_agg(to_jsonb(own)) FROM (${pendingQuery}) own), '[]'::jsonb) AS families,
    coalesce((SELECT jsonb_agg(to_jsonb(own)) FROM (${fieldQuery}) own), '[]'::jsonb) AS fields,
    (SELECT to_jsonb(coverage) FROM (${publishedAssessmentCoverageSql()}) coverage) AS coverage`);
  const pending = z
    .object({
      families: z.array(
        suggestionFamilyCount.pick({
          family: true,
          pending: true,
          clean: true,
          strong: true,
          medium: true,
          weak: true,
        }),
      ),
      coverage: assessmentReadCoverage,
      fields: z.array(
        suggestionFieldCount.pick({ entity: true, field: true, pending: true }),
      ),
    })
    .parse(pendingResult.rows[0]);
  const counts = await Promise.all(
    families.map(async (family) => {
      const presentation = suggestionFamilies[family];
      const outcomes = await presentation.outcomes(db, filters);
      const fields = new Map(
        outcomes.fields.map((row) => [
          JSON.stringify([row.entity, row.field]),
          { ...row, pending: 0 },
        ]),
      );
      if (family === "field")
        for (const row of pending.fields) {
          const key = JSON.stringify([row.entity, row.field]);
          fields.set(key, {
            applied: 0,
            rejected: 0,
            superseded: 0,
            resolved: 0,
            ...fields.get(key),
            ...row,
          });
        }
      return {
        family,
        ...(pending.families.find((row) => row.family === family) ??
          emptyPendingCounts()),
        ...outcomes,
        fields: [...fields.values()],
      };
    }),
  );
  return suggestionCountsOut.parse({
    families: counts,
    coverage: pending.coverage,
  });
}

const acceptAsIs = (row: SuggestionListRow) => {
  switch (row.family) {
    case "field":
      return suggestionFamilies.field.acceptAsIs(row);
    case "statement_transaction":
      return suggestionFamilies.statement_transaction.acceptAsIs(row);
    case "recommendation":
      return suggestionFamilies.recommendation.acceptAsIs(row);
    case "transfer_pair":
      return suggestionFamilies.transfer_pair.acceptAsIs(row);
    case "product_pair":
    case "image_description":
      return null;
  }
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
  const skip = new Set(input.skip);
  const filters = suggestionListFilters.parse({
    ...input.filters,
    status: "pending",
  });
  const relation = await publishedKeyRelation(db, filters);
  const selected = selectKeyQuery(
    db,
    relation,
    filters,
    [{ by: "ready", direction: "desc" }],
    { limit: input.limit, offset: 0 },
    and(
      eq(relationColumn("clean"), String(true)),
      skip.size
        ? sql`${relationColumn("id")} NOT IN (${sql.join(
            [...skip].map((id) => sql`${id}`),
            sql`, `,
          )})`
        : undefined,
    ),
  );
  // Selection and payload share one statement snapshot. The action handlers
  // still validate current evidence; a published clean flag grants no authority.
  const picked = await getDb(db)
    .execute(sql`SELECT p.row FROM (${selected}) selected
    JOIN ${assessmentReadPublication} p ON p."assessmentId" = selected.id::uuid
      AND p.family = selected.family AND p.active ORDER BY selected.position`);
  const rows = z
    .array(z.object({ row: suggestionListRow }))
    .parse(picked.rows)
    .map(({ row }) => row);
  const results: z.infer<typeof acceptCleanSuggestionsOut> = [];
  const settledPairs = new Set<string>();
  for (const row of rows) {
    const pairKey =
      row.family === "transfer_pair"
        ? row.evidence.key
        : row.family === "statement_transaction" &&
            row.evidence.transferPair?.clean
          ? row.evidence.transferPair.key
          : null;
    if (pairKey && settledPairs.has(pairKey)) {
      results.push({
        assessmentId: row.assessmentId,
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
        assessmentId: row.assessmentId,
        ok: false,
        error: "No longer clean under the current rules; review it on its own.",
      });
      continue;
    }
    const [result] = await reviewAssessmentBatch(db, context, {
      items: [item],
    });
    if (result) {
      results.push(result);
      if (result.ok && result.applied && pairKey) settledPairs.add(pairKey);
    }
  }
  return results;
}

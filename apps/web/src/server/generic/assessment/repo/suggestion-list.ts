import {
  suggestionRecordCountsInput,
  suggestionRecordCountsOut,
} from "@cubby/schemas/automatic-decision";
import {
  acceptCleanSuggestionsInput,
  type acceptCleanSuggestionsOut,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionGroup,
  suggestionListFamily,
  suggestionListFilters,
  suggestionListInput,
  suggestionListOut,
  type SuggestionColumnValue,
  type SuggestionGroup,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListRow,
} from "@cubby/schemas/suggestion-list";
import {
  suggestionDeclaredFilters,
  suggestionFilterDeclaration,
} from "@cubby/schemas/suggestion-list-declarations";
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
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { reviewAssessmentBatch } from "~/server/generic/assessment/repo/assessment-review";
import {
  type SuggestionFamilyQuery,
  type SuggestionKey,
  emptyPendingCounts,
  suggestionFamilies,
} from "~/server/generic/assessment/repo/suggestion-families";
import { compileDeclaredFilters } from "~/server/generic/list/repo/declared-filters";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  readAssessmentRecordRefs,
  touchingAssessmentIds,
} from "./review-families";

const STRENGTH_RANK = { strong: 2, medium: 1, weak: 0 } as const;
const ARRAY_COLUMNS = new Set(["account", "owner", "entityKind", "merchant"]);
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
function keyRelation(db: Database, keys: readonly SuggestionKey[]) {
  const facts = keys.map((key) => ({
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
  }));
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
  return getDb(db)
    .select(fields)
    .from(
      sql`jsonb_array_elements(${JSON.stringify(facts)}::jsonb) AS fact(value)`,
    )
    .as("suggestion_facts");
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

async function selectKeys(
  db: Database,
  keys: readonly SuggestionKey[],
  filters: SuggestionListFilters,
  order: readonly SortTerm[] = [],
  paging?: {
    limit: number;
    offset: number;
    cursor?: z.infer<typeof cursorSchema>;
  },
) {
  const relation = keyRelation(db, keys);
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
      id: sql<string>`${relationColumn("id")}`,
      vector: sql<SuggestionColumnValue[]>`jsonb_build_array(${sql.join(
        terms.slice(0, -1).map((term) => term.value),
        sql`, `,
      )})`,
    })
    .from(relation)
    .where(and(...predicates(filters), after))
    .orderBy(
      ...terms.map(
        (term) =>
          sql`${term.direction === "asc" ? asc(term.value) : desc(term.value)} NULLS LAST`,
      ),
    );
  const selected = paging
    ? await query.limit(paging.limit).offset(cursor ? 0 : paging.offset)
    : await query;
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
  const touching = await touchingAssessmentIds(db, {
    entity: filters.recordEntity,
    records: query.records,
    eligibility: {
      kind: "suggestions",
      families,
      status: filters.status,
      runCode: filters.runId,
    },
  });
  const familyScope = {
    filters: {
      ...query.filters,
      recordEntity: undefined,
      recordIds: undefined,
    },
    assessmentIds: touching ? [...touching] : undefined,
  };
  return { families, touching, familyScope };
}

async function scopedKeys(db: Database, filters: SuggestionListFilters) {
  const { families, touching, familyScope } = await scopedFamilyQuery(
    db,
    filters,
  );
  if (touching?.size === 0) return { families, keys: [], all: [] };
  const keys = (
    await Promise.all(
      families.map((family) =>
        suggestionFamilies[family].keys(db, familyScope),
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
  const rows = await hydrate(db, keys);
  const current = keys.filter((key) => rows.has(key.assessmentId));
  return {
    families,
    keys: (await selectKeys(db, current, filters)).map((entry) => entry.key),
    all: current,
    rows,
  };
}

/** Counts use the queue's eligibility and declared subjects, including either endpoint. */
export async function suggestionRecordCounts(
  db: Database,
  raw: z.input<typeof suggestionRecordCountsInput>,
) {
  const input = suggestionRecordCountsInput.parse(raw);
  if (!input.recordIds.length)
    return suggestionRecordCountsOut.parse({ records: [] });
  const { keys } = await scopedKeys(
    db,
    suggestionListFilters.parse({ recordIds: input.recordIds }),
  );
  const refs = await readAssessmentRecordRefs(
    db,
    keys.map((key) => key.assessmentId),
  );
  const counts = new Map(input.recordIds.map((id) => [id, 0]));
  for (const references of refs.values())
    for (const record of references)
      if (counts.has(record.id))
        counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  return suggestionRecordCountsOut.parse({
    records: [...counts].map(([id, pending]) => ({ id, pending })),
  });
}

async function hydrate(
  db: Database,
  keys: readonly SuggestionKey[],
): Promise<Map<string, SuggestionListRow>> {
  const byFamily = new Map<SuggestionListFamily, SuggestionKey[]>();
  for (const key of keys)
    byFamily.set(key.family, [...(byFamily.get(key.family) ?? []), key]);
  const maps: Map<string, SuggestionListRow>[] = await Promise.all(
    [...byFamily].map(([family, familyKeys]) =>
      suggestionFamilies[family].rows(db, familyKeys),
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
export async function listSuggestionPage(
  db: Database,
  raw: z.input<typeof suggestionListInput>,
) {
  const input = suggestionListInput.parse(raw);
  const grouped = input.group === "account_month";
  const filters = grouped
    ? { ...input, family: "statement_transaction" as const }
    : input;
  const {
    keys,
    all,
    rows = new Map<string, SuggestionListRow>(),
  } = await scopedKeys(db, filters);
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
  const { families, touching, familyScope } = await scopedFamilyQuery(
    db,
    filters,
  );
  const counts = await Promise.all(
    families.map(async (family) => {
      const presentation = suggestionFamilies[family];
      let pending = emptyPendingCounts();
      if (touching?.size !== 0) {
        if (
          "pendingCounts" in presentation &&
          presentation.pendingCounts &&
          !Object.keys(suggestionDeclaredFilters.shape).some(
            (name) => filters[name] !== undefined,
          )
        ) {
          pending = await presentation.pendingCounts(db, familyScope);
        } else {
          const { keys: own } = await scopedKeys(db, { ...filters, family });
          for (const key of own) {
            pending.pending++;
            if (key.clean) pending.clean++;
            pending[key.strength]++;
          }
        }
      }
      const outcomes = await presentation.outcomes(db, filters);
      return {
        family,
        ...pending,
        ...outcomes,
      };
    }),
  );
  return suggestionCountsOut.parse({ families: counts });
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
  const { keys } = await scopedKeys(db, {
    ...input.filters,
    status: "pending",
  });
  const entries = await selectKeys(
    db,
    keys.filter((key) => key.clean && !skip.has(key.assessmentId)),
    { ...input.filters, status: "pending" },
    [{ by: "ready", direction: "desc" }],
    { limit: input.limit, offset: 0 },
  );
  const hydrated = await hydrate(
    db,
    entries.map((entry) => entry.key),
  );
  const rows = entries.flatMap((entry) => {
    const row = hydrated.get(entry.id);
    return row ? [row] : [];
  });
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

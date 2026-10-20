import {
  suggestionRecordCountsInput,
  suggestionRecordCountsOut,
} from "@cubby/schemas/automatic-decision";
import {
  acceptCleanSuggestionsInput,
  type acceptCleanSuggestionsOut,
  suggestionColumns,
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
  type SuggestionOrder,
} from "@cubby/schemas/suggestion-list";
import { z } from "zod";

import type { Database } from "~/server/db";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { reviewAssessmentBatch } from "~/server/generic/assessment/repo/assessment-review";
import {
  type SuggestionFamilyQuery,
  type SuggestionKey,
  suggestionFamilies,
} from "~/server/generic/assessment/repo/suggestion-families";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  readAssessmentRecordRefs,
  touchingAssessmentIds,
} from "./review-families";

type Value = SuggestionColumnValue | SuggestionColumnValue[];
type Filter = SuggestionListFilters["where"][string];

const STRENGTH_RANK = { strong: 2, medium: 1, weak: 0 } as const;

/** A key's value for a column: common facts first, then the family's own. */
function columnValue(key: SuggestionKey, column: string): Value | undefined {
  switch (column) {
    case "family":
      return key.family;
    case "strength":
      return key.strength;
    case "clean":
      return key.clean;
    case "createdAt":
      return key.createdAt.toISOString();
    case "impact":
      return key.impact.filter((impact) => impact.qualityCheck).length;
    default:
      return key.columns[column];
  }
}

const knownColumns = (families: readonly SuggestionListFamily[]) =>
  new Set([
    ...Object.keys(suggestionColumns.common),
    ...families.flatMap((family) => Object.keys(suggestionColumns[family])),
  ]);

const facetsOf = (
  columns: (typeof suggestionColumns)[keyof typeof suggestionColumns],
) =>
  Object.entries(columns).flatMap(([column, spec]) =>
    "facet" in spec ? [column] : [],
  );
/** Common facets (the clean banner reads `clean`), plus one family's chips. */
const facetColumns = (families: readonly SuggestionListFamily[]) => [
  ...facetsOf(suggestionColumns.common),
  ...(families.length === 1 && families[0]
    ? facetsOf(suggestionColumns[families[0]])
    : []),
];

const values = (value: Value | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function compareScalars(a: SuggestionColumnValue, b: SuggestionColumnValue) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean")
    return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function matches(value: Value | undefined, filter: Filter) {
  const list = values(value);
  if (filter.in && !list.some((item) => filter.in?.includes(item)))
    return false;
  const needle = filter.search?.toLowerCase();
  if (
    needle &&
    !list.some(
      (item) => typeof item === "string" && item.toLowerCase().includes(needle),
    )
  )
    return false;
  const within = (bound: number | string, keep: (order: number) => boolean) =>
    list.some(
      (item) =>
        item !== null &&
        typeof item !== "boolean" &&
        keep(compareScalars(item, bound)),
    );
  if (filter.min !== undefined && !within(filter.min, (order) => order >= 0))
    return false;
  if (filter.max !== undefined && !within(filter.max, (order) => order <= 0))
    return false;
  return true;
}

type Vectored = {
  key: SuggestionKey;
  vector: SuggestionColumnValue[];
  id: string;
};

/** The values a key orders by under `order`, with each value's direction. */
function sortVector(key: SuggestionKey, order: readonly SuggestionOrder[]) {
  return order.flatMap((spec) => {
    const ready = [
      Number(key.clean),
      STRENGTH_RANK[key.strength],
      key.createdAt.getTime(),
    ];
    const parts: SuggestionColumnValue[] =
      spec.by === "ready"
        ? ready
        : spec.by === "impact"
          ? [Number(columnValue(key, "impact")), ...ready]
          : [values(columnValue(key, spec.by))[0] ?? null];
    return parts.map((value) => ({ value, direction: spec.direction }));
  });
}

function vectored(
  keys: readonly SuggestionKey[],
  order: readonly SuggestionOrder[],
) {
  const directions = keys[0]
    ? sortVector(keys[0], order).map((part) => part.direction)
    : [];
  const entries: Vectored[] = keys.map((key) => ({
    key,
    vector: sortVector(key, order).map((part) => part.value),
    id: key.assessmentId,
  }));
  const compare = (
    a: Pick<Vectored, "vector" | "id">,
    b: Pick<Vectored, "vector" | "id">,
  ) => {
    for (const [index, direction] of directions.entries()) {
      const left = a.vector[index] ?? null;
      const right = b.vector[index] ?? null;
      // A missing value sorts last in either direction.
      if (left === null || right === null) {
        if (left !== right) return left === null ? 1 : -1;
        continue;
      }
      const result = compareScalars(left, right);
      if (result) return direction === "desc" ? -result : result;
    }
    return a.id.localeCompare(b.id);
  };
  return { entries: entries.sort(compare), compare };
}

const cursorSchema = z.object({
  order: z.string(),
  vector: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  id: z.string(),
});

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

/** Keys passing every column filter except `skip`'s (a facet's own). */
function filterKeys(
  keys: readonly SuggestionKey[],
  where: SuggestionListFilters["where"],
  skip?: string,
) {
  const conditions = Object.entries(where).filter(
    ([column]) => column !== skip,
  );
  return keys.filter((key) =>
    conditions.every(([column, filter]) =>
      matches(columnValue(key, column), filter),
    ),
  );
}

async function scopedKeys(db: Database, filters: SuggestionListFilters) {
  const families = familiesOf(filters);
  const known = knownColumns(families);
  const unknown = Object.keys(filters.where).filter(
    (column) => !known.has(column),
  );
  if (unknown.length)
    throw new Error(
      `Unknown Suggestion column ${unknown.join(", ")}; columns here: ${[...known].join(", ")}`,
    );
  const scoped = filters;
  const query = await familyQuery(db, scoped);
  const touching = await touchingAssessmentIds(db, {
    entity: filters.entity,
    records: query.records,
  });
  const familyScope = {
    filters: { ...query.filters, entity: undefined, recordIds: undefined },
  };
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
        key.automaticRule === null &&
        (!touching || touching.has(key.assessmentId)),
    );
  return { families, keys: filterKeys(keys, filters.where), all: keys };
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

/** Up to `limit` current rows in order; a key whose evidence went stale is skipped. */
async function page(
  db: Database,
  ordered: readonly SuggestionKey[],
  limit: number,
) {
  const items: SuggestionListRow[] = [];
  let last = -1;
  let offset = 0;
  while (items.length < limit && offset < ordered.length) {
    const chunk = ordered.slice(offset, offset + limit - items.length);
    const rows = await hydrate(db, chunk);
    for (const [index, key] of chunk.entries()) {
      const row = rows.get(key.assessmentId);
      if (!row) continue;
      items.push(row);
      last = offset + index;
      if (items.length === limit) break;
    }
    offset += chunk.length;
  }
  return { items, last };
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

/**
 * One page of the cross-family Suggestion list. Every row in scope is keyed
 * first from cheap projections, so column filters, sorts, facets and groups
 * cover the whole set; only the page is hydrated with its evidence. Paging is
 * by `offset` (the table's infinite scroll) or by keyset `cursor`.
 */
export async function listSuggestionPage(
  db: Database,
  raw: z.input<typeof suggestionListInput>,
) {
  const input = suggestionListInput.parse(raw);
  const grouped = input.groups === "account_month";
  const filters = grouped
    ? { ...input, family: "statement_transaction" as const }
    : input;
  const { families, keys, all } = await scopedKeys(db, filters);
  const facets = Object.fromEntries(
    facetColumns(families).map((column) => {
      const counts = new Map<SuggestionColumnValue, number>();
      for (const key of filterKeys(all, input.where, column))
        for (const value of values(columnValue(key, column)))
          counts.set(value, (counts.get(value) ?? 0) + 1);
      return [
        column,
        [...counts]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count),
      ];
    }),
  );
  // Grouped pages lead with the section (newest month, then account), so
  // each section's rows are contiguous in page order.
  const order: SuggestionOrder[] = grouped
    ? [
        { by: "month", direction: "desc" },
        { by: "account", direction: "asc" },
        ...input.order,
      ]
    : input.order;
  const orderKey = JSON.stringify(order);
  const { entries, compare } = vectored(keys, order);
  let start = input.offset;
  if (input.cursor) {
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
    );
    if (cursor.order !== orderKey)
      throw new Error(
        "Cursor was issued for another order; restart without a cursor",
      );
    const after = entries.findIndex((entry) => compare(entry, cursor) > 0);
    start = after === -1 ? entries.length : after;
  }
  const { items, last } = await page(
    db,
    entries.slice(start).map((entry) => entry.key),
    input.limit,
  );
  const lastEntry = last >= 0 ? entries[start + last] : undefined;
  const more = lastEntry !== undefined && start + last < entries.length - 1;
  return suggestionListOut.parse({
    items,
    meta: {
      pageIndex: Math.floor(start / input.limit),
      pageSize: input.limit,
      totalCount: keys.length,
      ...(grouped
        ? { groups: statementGroups(entries.map((entry) => entry.key)) }
        : {}),
    },
    facets,
    next:
      more && items.length === input.limit
        ? Buffer.from(
            JSON.stringify({
              order: orderKey,
              vector: lastEntry.vector,
              id: lastEntry.id,
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
  const filters = {
    ...suggestionCountsInput.parse(raw),
    status: "pending" as const,
  };
  const { families, keys } = await scopedKeys(db, filters);
  const counts = await Promise.all(
    families.map(async (family) => {
      const own = keys.filter((key) => key.family === family);
      const outcomes = await suggestionFamilies[family].outcomes(db, filters);
      return {
        family,
        pending: own.length,
        clean: own.filter((key) => key.clean).length,
        strong: own.filter((key) => key.strength === "strong").length,
        medium: own.filter((key) => key.strength === "medium").length,
        weak: own.filter((key) => key.strength === "weak").length,
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
  const { entries } = vectored(
    keys.filter((key) => key.clean && !skip.has(key.assessmentId)),
    [{ by: "ready", direction: "desc" }],
  );
  const { items: rows } = await page(
    db,
    entries.map((entry) => entry.key),
    input.limit,
  );
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

import {
  acceptCleanSuggestionsInput,
  suggestionCountsInput,
  suggestionListFamily,
  suggestionListInput,
  suggestionListOut,
  suggestionCountsOut,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListRow,
  type SuggestionSort,
} from "@cubby/schemas/suggestion-list";
import { z } from "zod";

import type { Database } from "~/server/db";
import { listStatementSuggestionGroups } from "~/server/domains/statement-import/repo/statement-suggestion-read";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { reviewAssessmentBatch } from "~/server/generic/assessment/repo/assessment-review";
import {
  type SuggestionFamilyQuery,
  type SuggestionKey,
  suggestionFamilies,
} from "~/server/generic/assessment/suggestion-families";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

const STRENGTH_RANK = { strong: 2, medium: 1, weak: 0 } as const;
const qualityImpacts = (key: Pick<SuggestionKey, "impact">) =>
  key.impact.filter((impact) => impact.qualityCheck).length;

type Position = Pick<
  SuggestionKey,
  "assessmentId" | "clean" | "strength" | "createdAt"
> & { impactRank: number };

const position = (key: SuggestionKey): Position => ({
  assessmentId: key.assessmentId,
  clean: key.clean,
  strength: key.strength,
  createdAt: key.createdAt,
  impactRank: qualityImpacts(key),
});

/** Negative when `a` lists first. Ties break on Assessment id for a stable keyset. */
const comparators: Record<
  SuggestionSort,
  (a: Position, b: Position) => number
> = {
  ready: (a, b) =>
    Number(b.clean) - Number(a.clean) ||
    STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    a.assessmentId.localeCompare(b.assessmentId),
  impact: (a, b) => b.impactRank - a.impactRank || comparators.ready(a, b),
  newest: (a, b) =>
    b.createdAt.getTime() - a.createdAt.getTime() ||
    a.assessmentId.localeCompare(b.assessmentId),
};

const cursorSchema = z.object({
  sort: z.enum(["ready", "impact", "newest"]),
  assessmentId: z.string(),
  clean: z.boolean(),
  strength: z.enum(["strong", "medium", "weak"]),
  createdAt: z.number(),
  impactRank: z.number(),
});
const encodeCursor = (sort: SuggestionSort, at: Position) =>
  Buffer.from(
    JSON.stringify({ ...at, sort, createdAt: at.createdAt.getTime() }),
  ).toString("base64url");
function decodeCursor(sort: SuggestionSort, cursor: string): Position {
  const parsed = cursorSchema.parse(
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
  );
  if (parsed.sort !== sort)
    throw new Error(
      `Cursor was issued for sort "${parsed.sort}"; restart without a cursor to sort by "${sort}"`,
    );
  return { ...parsed, createdAt: new Date(parsed.createdAt) };
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

/** Every Suggestion in scope as sort keys; rows are hydrated page by page. */
async function suggestionKeys(db: Database, filters: SuggestionListFilters) {
  const query = await familyQuery(db, filters);
  const keys = (
    await Promise.all(
      familiesOf(filters).map((family) =>
        suggestionFamilies[family].keys(db, query),
      ),
    )
  ).flat();
  return keys.filter(
    (key) =>
      (filters.strength === undefined || key.strength === filters.strength) &&
      (filters.clean === undefined || key.clean === filters.clean),
  );
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

/** Rows after the cursor in sort order; stale keys are skipped, not counted. */
async function page(
  db: Database,
  ordered: readonly SuggestionKey[],
  limit: number,
) {
  const items: SuggestionListRow[] = [];
  let last: SuggestionKey | undefined;
  let offset = 0;
  while (items.length < limit && offset < ordered.length) {
    const chunk = ordered.slice(offset, offset + limit - items.length);
    offset += chunk.length;
    const rows = await hydrate(db, chunk);
    for (const key of chunk) {
      const row = rows.get(key.assessmentId);
      if (!row) continue;
      items.push(row);
      last = key;
      if (items.length === limit) break;
    }
  }
  const lastIndex = last ? ordered.indexOf(last) : -1;
  return {
    items,
    last,
    more: lastIndex >= 0 && lastIndex < ordered.length - 1,
  };
}

const ordered = (
  keys: SuggestionKey[],
  sort: SuggestionSort,
  after?: Position,
) => {
  const compare = comparators[sort];
  return keys
    .filter((key) => !after || compare(position(key), after) > 0)
    .sort((a, b) => compare(position(a), position(b)));
};

/** One page of the cross-family Suggestion list. */
export async function listSuggestionPage(
  db: Database,
  raw: z.input<typeof suggestionListInput>,
) {
  const input = suggestionListInput.parse(raw);
  const after = input.cursor
    ? decodeCursor(input.order, input.cursor)
    : undefined;
  const keys = ordered(await suggestionKeys(db, input), input.order, after);
  const { items, last, more } = await page(db, keys, input.limit);
  return suggestionListOut.parse({
    items,
    next:
      more && last && items.length === input.limit
        ? encodeCursor(input.order, position(last))
        : null,
    ...(input.groups === "account_month"
      ? { groups: await listStatementSuggestionGroups(db) }
      : {}),
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
  const keys = await suggestionKeys(db, filters);
  const families = await Promise.all(
    familiesOf(filters).map(async (family) => {
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
  return suggestionCountsOut.parse({ families });
}

const acceptAsIs = (row: SuggestionListRow) => {
  switch (row.family) {
    case "field":
      return suggestionFamilies.field.acceptAsIs(row);
    case "statement_transaction":
      return suggestionFamilies.statement_transaction.acceptAsIs(row);
    case "recommendation":
      return suggestionFamilies.recommendation.acceptAsIs(row);
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
  const keys = ordered(
    (
      await suggestionKeys(db, {
        ...input.filters,
        status: "pending",
        clean: true,
      })
    ).filter((key) => !skip.has(key.assessmentId)),
    "ready",
  );
  const { items: rows } = await page(db, keys, input.limit);
  const items = rows.flatMap((row) => {
    const item = acceptAsIs(row);
    return item ? [item] : [];
  });
  return items.length ? reviewAssessmentBatch(db, context, { items }) : [];
}

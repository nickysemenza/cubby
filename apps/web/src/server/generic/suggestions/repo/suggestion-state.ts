import type { SearchableEntity } from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ne,
  or,
  is,
  sql,
  SQL,
} from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { updateManyAndReturn } from "~/server/db/helpers/crud";
import {
  type RepositoryQueryInput,
  type RepositoryQueryTransaction as DrizzleTransaction,
  repositoryQueries as getDb,
} from "~/server/db/repository-access.boundary";
import { suggestionTable } from "~/server/db/retained-tables";
import { recordChange } from "~/server/generic/changes/repo/change";
import { jsonSnapshot } from "~/server/lib/canonical-json";

/** JSON metadata on both statement and transfer-pair Suggestions. */
export const suggestionStateData = z.record(z.string(), z.json());

/**
 * Versioned positional input deliberately avoids free-form JSON key ordering.
 * A schema change bumps the kind/version rather than silently missing a prior
 * dismissal.
 */
export async function suggestionCandidateKey(
  kind: string,
  values: readonly (string | number | boolean | null)[],
): Promise<string> {
  const tuple = [kind, ...values]
    .map((value) => String(value ?? ""))
    .join("\u001f");
  return `v1:${await sha256Hex(tuple)}`;
}

export async function getActiveSuggestionSuppressionKeys(
  db: Database,
  input: {
    entityKind: SearchableEntity;
    entityId: string;
    suggestionKind: string;
  },
): Promise<Set<string>> {
  const rows = await getDb(db)
    .select({ suppression: suggestionTable.suppression })
    .from(suggestionTable)
    .where(
      and(
        eq(suggestionTable.entity, input.entityKind),
        eq(suggestionTable.recordId, input.entityId),
        eq(suggestionTable.active, true),
        eq(suggestionTable.family, "recommendation"),
      ),
    );
  return new Set(
    rows.flatMap(({ suppression }) =>
      suppression?.scope === input.suggestionKind
        ? [suppression.candidateKey]
        : [],
    ),
  );
}

/** Evidence is immutable and can be very wide; nothing that moves a Suggestion reads it. */
const { evidence: _evidence, ...stateColumns } =
  getTableColumns(suggestionTable);
export const suggestionStateColumns = stateColumns;
export type SuggestionStateRow = Omit<
  typeof suggestionTable.$inferSelect,
  "evidence"
>;
type StateRow = SuggestionStateRow;
type TransitionResult = Pick<StateRow, "id" | "entity" | "active" | "status">;
type StateColumn = Exclude<
  keyof typeof suggestionTable.$inferInsert,
  "id" | "family" | "createdAt" | "updatedAt"
>;
/** Columns an event sets on the current projection; a present key is set. */
export type SuggestionStatePatch = Partial<
  Pick<typeof suggestionTable.$inferInsert, StateColumn>
>;

const projectedColumns = new Set<string>(
  Object.keys(getTableColumns(suggestionTable)).filter(
    (key) => !["id", "family", "createdAt", "updatedAt"].includes(key),
  ),
);

const projectionPatch = z.record(z.string(), z.json());
type ProjectionPatch = z.infer<typeof projectionPatch>;

/** Only current columns, as JSON; a transition takes values, not computed SQL. */
function projectionColumns(values: SuggestionStatePatch): ProjectionPatch {
  if (Object.values(values).some((value) => is(value, SQL)))
    throw new Error("Suggestion transitions take values, not SQL");
  const json = projectionPatch.parse(jsonSnapshot.parse(values));
  return Object.fromEntries(
    Object.entries(json).filter(([key]) => projectedColumns.has(key)),
  );
}

/** Patch values as column writes; a JSON null in a non-null jsonb column stays JSON. */
const columnWrites = (patch: ProjectionPatch): SuggestionStatePatch =>
  // SAFETY: `projectionColumns` keeps only Suggestion column keys, and each
  // value is the JSON that column stored.
  Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [
      key,
      key === "suggestedValue" && value === null ? sql`'null'::jsonb` : value,
    ]),
  ) as SuggestionStatePatch;

/**
 * The only writer of a Suggestion's status after publication. Unchanged columns
 * are not written.
 */
export async function transitionSuggestionStates(
  db: RepositoryQueryInput,
  where: SQL | undefined,
  patch:
    | SuggestionStatePatch
    | ((row: StateRow) => SuggestionStatePatch | null | undefined),
): Promise<TransitionResult[]> {
  return transitionSuggestionStateBatch(db, where, (rows) =>
    rows.flatMap((row) => {
      const next = typeof patch === "function" ? patch(row) : patch;
      return next ? [{ id: row.id, patch: next }] : [];
    }),
  );
}

/** One locked read and one set update for differing per-row transitions. The callback is pure and sees the complete locked set,
 * so domains can carry suppression across a publication without N rereads.
 */
export async function transitionSuggestionStateBatch(
  db: RepositoryQueryInput,
  where: SQL | undefined,
  prepare: (rows: readonly StateRow[]) => readonly {
    id: string;
    patch: SuggestionStatePatch;
  }[],
): Promise<TransitionResult[]> {
  const rows = await getDb(db)
    .select(suggestionStateColumns)
    .from(suggestionTable)
    .where(where)
    .orderBy(suggestionTable.id)
    .for("update");
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const changes: {
    row: StateRow;
    patch: ProjectionPatch;
  }[] = [];
  const seen = new Set<string>();
  for (const { id, patch } of prepare(rows)) {
    if (seen.has(id)) throw new Error("Duplicate SuggestionState transition");
    seen.add(id);
    const row = rowsById.get(id);
    if (!row)
      throw new Error("SuggestionState transition requires a locked row");
    const changed = Object.fromEntries(
      Object.entries(projectionColumns(patch)).filter(
        ([key, value]) =>
          // SAFETY: projectionColumns restricts keys to SuggestionState columns.
          !isEqual(
            value,
            jsonSnapshot.parse(row[key as keyof StateRow] ?? null),
          ),
      ),
    );
    if (Object.keys(changed).length) changes.push({ row, patch: changed });
  }
  if (!changes.length) return [];
  const updated = await updateManyAndReturn(db, suggestionTable, {
    key: "id",
    returning: ["id", "entity", "active", "status"],
    changes: changes.map(({ row, patch }) => ({
      keyValue: row.id,
      patch: columnWrites(patch),
    })),
  });
  if (updated.length !== changes.length)
    throw new Error("Locked SuggestionState disappeared during transition");
  await recordChange(db, {
    kind: "projection",
    categories: [
      "ai",
      "suggestions",
      "problems",
      ...updated.map((row) => row.entity),
    ],
  });
  return updated;
}

/** The record a Suggestion targets; only an answer for an unsaved record has none. */
export function suggestionRecordId(row: { recordId: string | null }) {
  if (row.recordId === null) throw new Error("Suggestion has no saved record");
  return row.recordId;
}

/** One row by id; null when it does not exist or nothing changed. */
export async function transitionSuggestionState(
  db: RepositoryQueryInput,
  id: string,
  patch: SuggestionStatePatch,
) {
  const [row] = await transitionSuggestionStates(
    db,
    eq(suggestionTable.id, id),
    patch,
  );
  return row ?? null;
}

/**
 * Replaced opinions are not history: a superseded row with no decision or
 * authority of its own goes once its replacement is published. Field rows stay,
 * since queued evaluations and settled answers name them by id.
 */
export async function pruneReplacedSuggestions(
  db: RepositoryQueryInput,
  ids: readonly string[],
) {
  if (!ids.length) return;
  await getDb(db)
    .delete(suggestionTable)
    .where(
      and(
        inArray(suggestionTable.id, [...ids]),
        ne(suggestionTable.family, "field"),
        eq(suggestionTable.status, "superseded"),
        sql`${suggestionTable.decisions} = '[]'::jsonb`,
        isNull(suggestionTable.suppression),
        isNull(suggestionTable.confirmedValue),
        isNull(suggestionTable.acceptanceReceipt),
      ),
    );
}

const retired = {
  active: false,
  status: "superseded",
  confirmedValue: null,
  suppression: null,
} satisfies SuggestionStatePatch;

/** Retire current targets across families; immutable subjects and Feedback remain original. */
export async function retireSuggestionTargetsTx(
  tx: DrizzleTransaction,
  entityKind: string,
  entityIds: readonly string[],
): Promise<void> {
  if (!entityIds.length) return;
  const ids = [...entityIds];
  await transitionSuggestionStates(
    tx,
    and(
      eq(suggestionTable.entity, entityKind),
      or(
        inArray(suggestionTable.recordId, ids),
        inArray(sql`${suggestionTable.data}->>'otherId'`, ids),
      ),
    ),
    retired,
  );
}

/** Repoint only current projections onto a merge survivor; subjects never change. */
export async function repointSuggestionTargetsTx(
  tx: DrizzleTransaction,
  entity: string,
  keepId: string,
  loserIds: readonly string[],
) {
  if (!loserIds.length) return;
  await transitionSuggestionStates(
    tx,
    and(
      eq(suggestionTable.entity, entity),
      inArray(suggestionTable.recordId, [...loserIds]),
      eq(suggestionTable.family, "field"),
    ),
    { recordId: keepId, status: "superseded", confirmedValue: null },
  );
}

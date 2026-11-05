import {
  assessmentProjectionPatch,
  retiredAssessmentFamilies,
} from "@cubby/schemas/assessment";
import type { SearchableEntity } from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ne,
  notInArray,
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

/**
 * Versioned positional input deliberately avoids free-form JSON key ordering.
 * A schema change bumps the kind/version rather than silently missing a prior
 * dismissal.
 */
export async function assessmentCandidateKey(
  kind: string,
  values: readonly (string | number | boolean | null)[],
): Promise<string> {
  const tuple = [kind, ...values]
    .map((value) => String(value ?? ""))
    .join("\u001f");
  return `v1:${await sha256Hex(tuple)}`;
}

export async function getActiveAssessmentSuppressionKeys(
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
export type AssessmentStatePatch = Partial<
  Pick<typeof suggestionTable.$inferInsert, StateColumn>
>;
/** Why the projection moved: a system maintenance kind or the Feedback that caused it. */
export type ProjectionCause = { kind: string; feedbackId?: string };

const projectedColumns = new Set<string>(
  Object.keys(getTableColumns(suggestionTable)).filter(
    (key) => !["id", "family", "createdAt", "updatedAt"].includes(key),
  ),
);

type ProjectionPatch = z.infer<typeof assessmentProjectionPatch>;

/** Only current columns, as JSON; a transition takes values, not computed SQL. */
function projectionColumns(values: AssessmentStatePatch): ProjectionPatch {
  if (Object.values(values).some((value) => is(value, SQL)))
    throw new Error("Suggestion transitions take values, not SQL");
  const json = assessmentProjectionPatch.parse(jsonSnapshot.parse(values));
  return Object.fromEntries(
    Object.entries(json).filter(([key]) => projectedColumns.has(key)),
  );
}

/** Patch values as column writes; a JSON null in a non-null jsonb column stays JSON. */
const columnWrites = (patch: ProjectionPatch): AssessmentStatePatch =>
  // SAFETY: `projectionColumns` keeps only Suggestion column keys, and each
  // value is the JSON that column stored.
  Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [
      key,
      key === "suggestedValue" && value === null ? sql`'null'::jsonb` : value,
    ]),
  ) as AssessmentStatePatch;

/**
 * The only writer of a Suggestion's status after publication. Unchanged columns
 * are not written. `cause` names why a transition happened for the caller's
 * reader; it is not stored, since transitions keep no event history.
 */
export async function transitionAssessmentStates(
  db: RepositoryQueryInput,
  where: SQL | undefined,
  patch:
    | AssessmentStatePatch
    | ((row: StateRow) => AssessmentStatePatch | null | undefined),
  cause: ProjectionCause,
): Promise<TransitionResult[]> {
  return transitionAssessmentStateBatch(db, where, (rows) =>
    rows.flatMap((row) => {
      const next = typeof patch === "function" ? patch(row) : patch;
      return next ? [{ id: row.id, patch: next, cause }] : [];
    }),
  );
}

/** One locked read and one set update for differing per-row transitions. The callback is pure and sees the complete locked set,
 * so domains can carry suppression across a publication without N rereads.
 */
export async function transitionAssessmentStateBatch(
  db: RepositoryQueryInput,
  where: SQL | undefined,
  prepare: (rows: readonly StateRow[]) => readonly {
    id: string;
    patch: AssessmentStatePatch;
    cause: ProjectionCause;
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
    cause: ProjectionCause;
  }[] = [];
  const seen = new Set<string>();
  for (const { id, patch, cause } of prepare(rows)) {
    if (seen.has(id)) throw new Error("Duplicate AssessmentState transition");
    seen.add(id);
    const row = rowsById.get(id);
    if (!row)
      throw new Error("AssessmentState transition requires a locked row");
    const changed = Object.fromEntries(
      Object.entries(projectionColumns(patch)).filter(
        ([key, value]) =>
          // SAFETY: projectionColumns restricts keys to AssessmentState columns.
          !isEqual(
            value,
            jsonSnapshot.parse(row[key as keyof StateRow] ?? null),
          ),
      ),
    );
    if (Object.keys(changed).length)
      changes.push({ row, patch: changed, cause });
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
    throw new Error("Locked AssessmentState disappeared during transition");
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
export async function transitionAssessmentState(
  db: RepositoryQueryInput,
  id: string,
  patch: AssessmentStatePatch,
  cause: ProjectionCause,
) {
  const [row] = await transitionAssessmentStates(
    db,
    eq(suggestionTable.id, id),
    patch,
    cause,
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
} satisfies AssessmentStatePatch;

/** Retire current targets across families; immutable subjects and Feedback remain original. */
export async function retireAssessmentTargetsTx(
  tx: DrizzleTransaction,
  entityKind: string,
  entityIds: readonly string[],
): Promise<void> {
  if (!entityIds.length) return;
  const ids = [...entityIds];
  await transitionAssessmentStates(
    tx,
    and(
      notInArray(suggestionTable.family, [...retiredAssessmentFamilies]),
      eq(suggestionTable.entity, entityKind),
      or(
        inArray(suggestionTable.recordId, ids),
        inArray(sql`${suggestionTable.data}->>'otherId'`, ids),
      ),
    ),
    retired,
    { kind: "target_removed" },
  );
}

/** Repoint only current projections onto a merge survivor; subjects never change. */
export async function repointAssessmentTargetsTx(
  tx: DrizzleTransaction,
  entity: string,
  keepId: string,
  loserIds: readonly string[],
) {
  if (!loserIds.length) return;
  await transitionAssessmentStates(
    tx,
    and(
      eq(suggestionTable.entity, entity),
      inArray(suggestionTable.recordId, [...loserIds]),
      eq(suggestionTable.family, "field"),
    ),
    { recordId: keepId, status: "superseded", confirmedValue: null },
    { kind: "target_merged" },
  );
}

import { assessmentProjectionPatch } from "@cubby/schemas/assessment";
import type { SearchableEntity } from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
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
import {
  assessment,
  assessmentState,
  feedback,
} from "~/server/db/retained-tables";
import { recordChange } from "~/server/generic/changes/repo/change";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

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
    .select({ suppression: assessmentState.suppression })
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.entity, input.entityKind),
        eq(assessmentState.recordId, input.entityId),
        eq(assessmentState.active, true),
        eq(assessmentState.family, "recommendation"),
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

type StateRow = typeof assessmentState.$inferSelect;
type TransitionResult = Pick<StateRow, "id" | "entity" | "active" | "status">;
type StateColumn = Exclude<
  keyof typeof assessmentState.$inferInsert,
  "id" | "family" | "createdAt" | "updatedAt"
>;
/** Columns an event sets on the current projection; a present key is set. */
export type AssessmentStatePatch = Partial<
  Pick<typeof assessmentState.$inferInsert, StateColumn>
>;
/** Why the projection moved: a system maintenance kind or the Feedback that caused it. */
export type ProjectionCause = { kind: string; feedbackId?: string };

const projectedColumns = new Set<string>(
  Object.keys(getTableColumns(assessmentState)).filter(
    (key) => !["id", "family", "createdAt", "updatedAt"].includes(key),
  ),
);

type ProjectionPatch = z.infer<typeof assessmentProjectionPatch>;

/** Only current columns, as JSON; retired keys in old snapshots are ignored. */
function projectionColumns(
  values: Partial<typeof assessmentState.$inferInsert> | ProjectionPatch,
): ProjectionPatch {
  // A replayable patch is a value; SQL computed in place could not be replayed.
  if (Object.values(values).some((value) => is(value, SQL)))
    throw new Error("AssessmentState transitions take values, not SQL");
  const json = assessmentProjectionPatch.parse(jsonSnapshot.parse(values));
  return Object.fromEntries(
    Object.entries(json).filter(([key]) => projectedColumns.has(key)),
  );
}

/** The creation snapshot `publishAssessment` stores on the Assessment. */
export const assessmentProjectionSnapshot = (
  values: Partial<typeof assessmentState.$inferInsert>,
) => projectionColumns(values);

/** Patch values as column writes; a JSON null in a non-null jsonb column stays JSON. */
const columnWrites = (patch: ProjectionPatch): AssessmentStatePatch =>
  // SAFETY: `projectionColumns` keeps only AssessmentState column keys, and
  // each value is the JSON that column stored.
  Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [
      key,
      key === "suggestedValue" && value === null ? sql`'null'::jsonb` : value,
    ]),
  ) as AssessmentStatePatch;

async function recordProjectionEvents(
  db: RepositoryQueryInput,
  events: readonly { id: string; patch: ProjectionPatch }[],
  cause: ProjectionCause,
) {
  await getDb(db)
    .insert(feedback)
    .values(
      events.map(({ id, patch }) => ({
        assessmentId: id,
        operationId: `projection:${crypto.randomUUID()}`,
        verdict: "ungraded" as const,
        correction: { present: false as const },
        intent: "projection",
        authority: "system",
        actorUserId: null,
        metadata: cause,
        projection: patch,
        // Statement time orders several events of one transaction for replay.
        createdAt: sql`clock_timestamp()`,
      })),
    );
}

/**
 * The only writer of AssessmentState after publication. Each changed row
 * gains a `system` projection Feedback event carrying its column patch, so
 * {@link rebuildAssessmentStates} replays the same row. Member and automatic
 * judgments stay in their own Feedback; their state effect names them as the
 * cause. Unchanged columns are not recorded.
 * Returns native metadata for change categories, counts and current open state;
 * locked reads and replay patches retain the evidence.
 */
export async function transitionAssessmentStates(
  db: RepositoryQueryInput,
  where: SQL | undefined,
  patch:
    | AssessmentStatePatch
    | ((row: StateRow) => AssessmentStatePatch | null | undefined),
  cause: ProjectionCause,
): Promise<TransitionResult[]> {
  const client = getDb(db);
  const rows = await client
    .select()
    .from(assessmentState)
    .where(where)
    .orderBy(assessmentState.id)
    .for("update");
  const changes: { row: StateRow; patch: ProjectionPatch }[] = [];
  for (const row of rows) {
    const next = typeof patch === "function" ? patch(row) : patch;
    if (!next) continue;
    const changed = Object.fromEntries(
      Object.entries(projectionColumns(next)).filter(
        ([key, value]) =>
          !isEqual(
            value,
            // SAFETY: `projectionColumns` keeps only AssessmentState columns.
            jsonSnapshot.parse(row[key as keyof StateRow] ?? null),
          ),
      ),
    );
    if (Object.keys(changed).length) changes.push({ row, patch: changed });
  }
  if (!changes.length) return [];
  await recordProjectionEvents(
    db,
    changes.map(({ row, patch: changed }) => ({ id: row.id, patch: changed })),
    cause,
  );
  const updated = await updateManyAndReturn(db, assessmentState, {
    key: "id",
    returning: ["id", "entity", "active", "status"],
    changes: changes.map(({ row, patch: changed }) => ({
      keyValue: row.id,
      patch: columnWrites(changed),
    })),
  });
  if (updated.length !== changes.length)
    throw new Error("Locked AssessmentState disappeared during transition");
  if (updated.length)
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

/** One row by id; null when it does not exist or nothing changed. */
export async function transitionAssessmentState(
  db: RepositoryQueryInput,
  id: string,
  patch: AssessmentStatePatch,
  cause: ProjectionCause,
) {
  const [row] = await transitionAssessmentStates(
    db,
    eq(assessmentState.id, id),
    patch,
    cause,
  );
  return row ?? null;
}

/**
 * Creates current rows only for newly published Assessments. Each Assessment's
 * `projection` holds the same snapshot, so no projection event is recorded.
 */
export async function insertPublishedAssessmentStates(
  db: RepositoryQueryInput,
  values: readonly (typeof assessmentState.$inferInsert & { id: string })[],
) {
  if (!values.length) return;
  await getDb(db)
    .insert(assessmentState)
    .values(
      values.map((value) => ({
        ...value,
        // A JSON null suggestion stays a JSON value, not SQL NULL.
        suggestedValue:
          value.suggestedValue === null
            ? sql`'null'::jsonb`
            : value.suggestedValue,
      })),
    );
  await recordChange(db, {
    kind: "projection",
    categories: [
      ...new Set([
        "ai",
        "suggestions",
        "problems",
        ...values.map((value) => value.entity),
      ]),
    ],
  });
}

/**
 * Opens review state for an Assessment published without it, recording the
 * full row as its first projection event; an existing row takes `patch`.
 */
export async function openAssessmentState(
  db: RepositoryQueryInput,
  input: {
    values: typeof assessmentState.$inferInsert & { id: string };
    patch: AssessmentStatePatch;
  },
  cause: ProjectionCause,
) {
  const [opened] = await getDb(db)
    .insert(assessmentState)
    .values({
      ...input.values,
      // Saved-field None receipts obey the same JSON-null invariant as publication.
      suggestedValue:
        input.values.suggestedValue === null
          ? sql`'null'::jsonb`
          : input.values.suggestedValue,
    })
    .onConflictDoNothing({ target: assessmentState.id })
    .returning();
  if (!opened)
    return transitionAssessmentState(db, input.values.id, input.patch, cause);
  await recordProjectionEvents(
    db,
    [{ id: opened.id, patch: projectionColumns(opened) }],
    cause,
  );
  await recordChange(db, {
    kind: "projection",
    categories: ["ai", "suggestions", "problems", opened.entity],
  });
  return opened;
}

/**
 * Replays each Assessment's creation snapshot and its Feedback patches in
 * order, replacing the current rows. An Assessment with neither has no row.
 */
export async function rebuildAssessmentStates(
  db: RepositoryQueryInput,
  assessmentIds: readonly string[],
): Promise<StateRow[]> {
  if (!assessmentIds.length) return [];
  const client = getDb(db);
  const ids = [...new Set(assessmentIds)];
  const published = await client
    .select({
      id: assessment.id,
      family: assessment.family,
      projection: assessment.projection,
      createdAt: assessment.createdAt,
    })
    .from(assessment)
    .where(inArray(assessment.id, ids));
  const events = await client
    .select({
      assessmentId: feedback.assessmentId,
      projection: feedback.projection,
    })
    .from(feedback)
    .where(
      and(inArray(feedback.assessmentId, ids), isNotNull(feedback.projection)),
    )
    .orderBy(asc(feedback.createdAt), asc(feedback.id));
  const rebuilt: StateRow[] = [];
  for (const row of published) {
    const patches = events.filter((event) => event.assessmentId === row.id);
    if (row.projection === null && !patches.length) {
      await client
        .delete(assessmentState)
        .where(eq(assessmentState.id, row.id));
      continue;
    }
    const values = columnWrites(
      Object.assign(
        {},
        projectionColumns(
          assessmentProjectionPatch.parse(row.projection ?? {}),
        ),
        ...patches.map((event) =>
          projectionColumns(assessmentProjectionPatch.parse(event.projection)),
        ),
      ),
    );
    const [state] = await client
      .insert(assessmentState)
      .values({
        // SAFETY: a replayed creation snapshot names every required column.
        ...(values as typeof assessmentState.$inferInsert),
        id: row.id,
        family: row.family,
        createdAt: row.createdAt,
      })
      .onConflictDoUpdate({ target: assessmentState.id, set: values })
      .returning();
    rebuilt.push(state!);
  }
  return rebuilt;
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
  // A removed Email keeps its link review on the retained order event.
  if (entityKind === "email")
    await transitionAssessmentStates(
      tx,
      and(
        eq(assessmentState.family, "email_link"),
        eq(assessmentState.entity, "email"),
        inArray(assessmentState.recordId, ids),
      ),
      (row) => ({
        entity: "orderMailEvent",
        recordId: z.object({ eventId: z.uuid() }).passthrough().parse(row.data)
          .eventId,
      }),
      { kind: "target_removed" },
    );
  await transitionAssessmentStates(
    tx,
    or(
      and(
        eq(assessmentState.entity, entityKind),
        or(
          inArray(assessmentState.recordId, ids),
          inArray(sql`${assessmentState.data}->>'otherId'`, ids),
        ),
      ),
      entityKind === "purchase"
        ? and(
            eq(assessmentState.family, "email_link"),
            inArray(sql`${assessmentState.data}->>'purchaseId'`, ids),
          )
        : undefined,
    ),
    retired,
    { kind: "target_removed" },
  );
}

const findingData = z.object({ kind: z.string() }).passthrough();

/** Repoint only current projections onto a merge survivor; subjects never change. */
export async function repointAssessmentTargetsTx(
  tx: DrizzleTransaction,
  entity: string,
  keepId: string,
  loserIds: readonly string[],
) {
  if (!loserIds.length) return;
  const cause = { kind: "target_merged" };
  await transitionAssessmentStates(
    tx,
    and(
      eq(assessmentState.entity, entity),
      inArray(assessmentState.recordId, [...loserIds]),
      eq(assessmentState.family, "field"),
    ),
    { recordId: keepId, status: "superseded", confirmedValue: null },
    cause,
  );
  // An open finding the survivor already carries for the same evidence is
  // one finding; any other finding follows the survivor with its review.
  const open = await tx
    .select()
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.family, "run_finding"),
        eq(assessmentState.entity, entity),
        eq(assessmentState.recordId, keepId),
        eq(assessmentState.active, true),
        eq(assessmentState.status, "pending"),
      ),
    );
  const openKey = (row: StateRow) =>
    canonicalJson([
      row.ledgerPartyId,
      findingData.parse(row.data).kind,
      row.fingerprint,
    ]);
  const survivorOpen = new Set(open.map(openKey));
  await transitionAssessmentStates(
    tx,
    and(
      eq(assessmentState.family, "run_finding"),
      eq(assessmentState.entity, entity),
      inArray(assessmentState.recordId, [...loserIds]),
    ),
    (row) => {
      if (row.active && row.status === "pending") {
        const key = openKey(row);
        if (survivorOpen.has(key))
          return { active: false, status: "superseded" };
        survivorOpen.add(key);
      }
      return { recordId: keepId };
    },
    cause,
  );
  if (entity !== "purchase") return;
  const rows = await tx
    .select()
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.family, "email_link"),
        eq(assessmentState.active, true),
        inArray(sql`${assessmentState.data}->>'purchaseId'`, [
          keepId,
          ...loserIds,
        ]),
      ),
    )
    .orderBy(assessmentState.id)
    .for("update");
  const linkTarget = z
    .object({
      eventId: z.uuid(),
      purchaseId: z.uuid(),
      decision: z.enum(["linked", "dismissed"]),
    })
    .passthrough();
  const events = new Map<string, StateRow[]>();
  for (const row of rows) {
    const data = linkTarget.parse(row.data);
    events.set(data.eventId, [...(events.get(data.eventId) ?? []), row]);
  }
  for (const values of events.values()) {
    const winner =
      values.find((row) => linkTarget.parse(row.data).decision === "linked") ??
      values.find((row) => linkTarget.parse(row.data).purchaseId === keepId) ??
      values[0]!;
    await transitionAssessmentStates(
      tx,
      inArray(
        assessmentState.id,
        values.map((row) => row.id),
      ),
      (row) =>
        row.id === winner.id
          ? {
              data: {
                ...linkTarget.parse(row.data),
                purchaseId: keepId,
              },
            }
          : { active: false, status: "superseded" },
      cause,
    );
  }
}

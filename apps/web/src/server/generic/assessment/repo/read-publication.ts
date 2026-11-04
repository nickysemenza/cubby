import {
  ASSESSMENT_READ_TARGET,
  assessmentReadResult,
  type AssessmentReadResult,
} from "@cubby/schemas/assessment-read-publication";
import type { Entity } from "@cubby/schemas/entity";
import { and, arrayOverlaps, eq, inArray, not, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { outer, related } from "~/server/db/helpers/related";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  assessmentReadDependency,
  assessmentReadMembership,
  assessmentReadPublication,
  assessmentReadStage,
  assessmentState,
  entityIdentity,
} from "~/server/db/retained-tables";
import { fanoutTargetMatches } from "~/server/generic/derived/repo/fanout";
import { unobservedWork } from "~/server/generic/jobs/repo/work-items";
import { sha256CanonicalJson } from "~/server/lib/canonical-json";

export type AssessmentReadStagePlan = Omit<
  typeof assessmentReadStage.$inferSelect,
  "createdAt"
>;
export type AssessmentReadStageWrite = {
  stage: AssessmentReadStagePlan;
  /** Exact continuations observed before preparation, including components that merged. */
  previousStageIds: readonly string[];
  results: readonly AssessmentReadResult[];
};

/** Canonical reads and ticket observations must describe one committed snapshot. */
export function withAssessmentReadSnapshot<T>(
  db: Database,
  read: (snapshot: Database) => Promise<T>,
): Promise<T> {
  return repositoryTransactionDatabase(db, read, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function readAssessmentReadStage(
  db: RepositoryQueryInput,
  componentKey: string,
): Promise<typeof assessmentReadStage.$inferSelect | undefined> {
  const [stage] = await repositoryQueries(db)
    .select()
    .from(assessmentReadStage)
    .where(eq(assessmentReadStage.componentKey, componentKey));
  return stage;
}

export type AssessmentReadFrame = {
  headers: { id: string; groupKey: string }[];
  stages: (typeof assessmentReadStage.$inferSelect)[];
};

/** Historical inactive peers cannot enter a new pending publication component. */
export async function readOpenAssessmentReadIds(
  db: RepositoryQueryInput,
  ids: readonly string[],
): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await repositoryQueries(db)
    .select({ id: assessmentState.id })
    .from(assessmentState)
    .where(
      and(
        assessmentState.active,
        eq(assessmentState.status, "pending"),
        sql`${assessmentState.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
  return rows.map((row) => row.id);
}

/** Retained winners and unfinished components connect the old and new edge scopes. */
export async function readAssessmentReadFrame(
  db: RepositoryQueryInput,
  ids: readonly string[],
  groups: readonly string[],
): Promise<AssessmentReadFrame> {
  const headers = await repositoryQueries(db)
    .selectDistinct({
      id: assessmentReadPublication.assessmentId,
      groupKey: assessmentReadPublication.groupKey,
    })
    .from(assessmentReadPublication)
    .leftJoin(
      assessmentState,
      eq(assessmentState.id, assessmentReadPublication.assessmentId),
    )
    .where(
      and(
        assessmentReadPublication.active,
        or(
          sql`${assessmentReadPublication.assessmentId} = ANY(${uuidArrayParam(ids)})`,
          inArray(assessmentReadPublication.groupKey, [...groups]),
        ),
        or(
          assessmentReadPublication.admitted,
          and(assessmentState.active, eq(assessmentState.status, "pending")),
          sql`${assessmentReadPublication.assessmentId} = ANY(${uuidArrayParam(ids)})`,
        ),
      ),
    );
  const groupOverlap = groups.length
    ? sql`${assessmentReadStage.groups} ?| ARRAY[${sql.join(
        groups.map((group) => sql`${group}`),
        sql`, `,
      )}]::text[]`
    : sql`false`;
  const stages = await repositoryQueries(db)
    .select()
    .from(assessmentReadStage)
    .where(
      and(
        sql`${assessmentReadStage.nextIndex} < cardinality(${assessmentReadStage.assessmentIds})`,
        or(
          arrayOverlaps(assessmentReadStage.assessmentIds, [...ids]),
          groupOverlap,
        ),
      ),
    );
  return { headers, stages };
}

/** Abandoned staging never removes a revision that is still the read authority. */
async function removeInactiveRevisions(
  db: RepositoryQueryInput,
  ids: readonly string[],
  revisions: readonly string[],
) {
  for (const table of [assessmentReadPublication, assessmentReadMembership])
    await repositoryQueries(db)
      .delete(table)
      .where(
        and(
          sql`${table.assessmentId} = ANY(${uuidArrayParam(ids)})`,
          sql`${table.revision} = ANY(${uuidArrayParam(revisions)})`,
          not(
            related(assessmentReadPublication, (header) =>
              and(
                header.active,
                eq(header.assessmentId, outer(table.assessmentId)),
                eq(header.revision, outer(table.revision)),
              )!,
            ).exists(),
          ),
        ),
      );
}

/** Exact peer and source generations, observed before canonical preparation. */
async function stageInvalidated(
  db: RepositoryQueryInput,
  stage: AssessmentReadStagePlan,
) {
  const rows = await repositoryQueries(db).execute(
    sql`SELECT ${unobservedWork(
      (target) =>
        or(
          eq(target, ASSESSMENT_READ_TARGET),
          fanoutTargetMatches(target, sql`${ASSESSMENT_READ_TARGET}::text`),
        )!,
      stage.tickets.map((item) => item.ticket),
      { target: ASSESSMENT_READ_TARGET, refs: stage.assessmentIds },
    )} AS invalidated`,
  );
  return z.tuple([z.object({ invalidated: z.boolean() })]).parse(rows.rows)[0]
    .invalidated;
}

/**
 * Called only inside the drain's source/ticket/lease-fenced publication.
 * Partial results stay invisible; the last chunk activates the whole component.
 */
export async function writeAssessmentReadStage(
  db: RepositoryQueryInput,
  prepared: AssessmentReadStageWrite,
  publication: { notify(entity: Entity, ids: readonly string[]): void },
): Promise<{ kind: "retained" | "activated"; changed: string[] }> {
  const tx = repositoryQueries(db);
  const { stage } = prepared;
  const results = prepared.results.map((result) =>
    assessmentReadResult.parse(result),
  );
  const expected = stage.assessmentIds.slice(
    stage.nextIndex,
    stage.nextIndex + results.length,
  );
  if (
    JSON.stringify(results.map((result) => result.assessmentId)) !==
    JSON.stringify(expected)
  )
    throw new Error(
      "Assessment stage results must be its exact preparation prefix",
    );
  const existing = await readAssessmentReadStage(db, stage.componentKey);
  if (
    existing &&
    JSON.stringify(existing.groups) !== JSON.stringify(stage.groups)
  )
    throw new Error("Assessment component hash matched different groups");
  if (existing && existing.id !== stage.id) {
    if (!prepared.previousStageIds.includes(existing.id))
      return { kind: "retained", changed: [] };
  } else if (existing && existing.nextIndex !== stage.nextIndex) {
    return { kind: "retained", changed: [] };
  } else if (
    existing &&
    (existing.revision !== stage.revision ||
      existing.rulesVersion !== stage.rulesVersion ||
      JSON.stringify(existing.assessmentIds) !==
        JSON.stringify(stage.assessmentIds) ||
      existing.tickets.length !== stage.tickets.length ||
      !existing.tickets.every((ticket, index) => {
        const other = stage.tickets[index];
        // jsonb can reorder object keys; the observed tuple is the invariant.
        return (
          other !== undefined &&
          ticket.target === other.target &&
          ticket.ref === other.ref &&
          ticket.ticket === other.ticket
        );
      }))
  ) {
    throw new Error("Assessment continuation metadata is immutable");
  }
  if (await stageInvalidated(db, stage))
    return { kind: "retained", changed: [] };
  if (prepared.previousStageIds.length) {
    const previous = await tx
      .select()
      .from(assessmentReadStage)
      .where(
        sql`${assessmentReadStage.id} = ANY(${uuidArrayParam(prepared.previousStageIds)})`,
      );
    const members = new Set(stage.assessmentIds);
    const groups = new Set(stage.groups);
    for (const old of previous) {
      if (old.id === stage.id) continue;
      if (
        !old.assessmentIds.some((id) => members.has(id)) &&
        !old.groups.some((group) => groups.has(group))
      )
        throw new Error("Cannot retire an unrelated Assessment stage");
      if (
        old.nextIndex < old.assessmentIds.length &&
        old.assessmentIds.some((id) => !members.has(id))
      )
        throw new Error(
          "A merged Assessment stage must retain every unfinished member",
        );
      await tx
        .delete(assessmentReadStage)
        .where(eq(assessmentReadStage.id, old.id));
      await removeInactiveRevisions(db, old.assessmentIds, [old.revision]);
    }
  }
  await tx.insert(assessmentReadStage).values(stage).onConflictDoNothing();
  if (stage.nextIndex === stage.assessmentIds.length)
    return { kind: "activated", changed: [] };
  if (!results.length)
    throw new Error("An incomplete Assessment stage must advance");
  const memberships = results.flatMap((result) =>
    result.memberships.map((membership, ordinal) => ({
      assessmentId: result.assessmentId,
      revision: stage.revision,
      ordinal,
      ...membership,
    })),
  );
  if (memberships.length)
    await tx.insert(assessmentReadMembership).values(memberships);
  const staged = await Promise.all(
    results.map(async (result) => {
      const metadata = {
        assessmentId: result.assessmentId,
        revision: stage.revision,
        active: false,
        rulesVersion: stage.rulesVersion,
        groupKey: result.groupKey,
        contentHash: await sha256CanonicalJson(result),
        computedAt: sql<Date>`now()`,
        dependencies: result.dependencies,
      };
      // An explicit empty result is a successful revision; absent rows remain missing.
      if (!result.facts.length)
        return [
          {
            ...metadata,
            admitted: false,
            family: null,
            key: null,
            filters: null,
            row: null,
          },
        ];
      return result.facts.map((fact) => ({
        ...metadata,
        admitted: true,
        family: fact.key.family,
        key: fact.key,
        filters: fact.filters,
        row: fact.row,
      }));
    }),
  );
  await tx.insert(assessmentReadPublication).values(staged.flat());
  // Source fanouts share this drain's lease, so they cannot expand until this
  // transaction commits. Enroll newly read references now: a later fanout must
  // find them even while this component's active revision is still unchanged.
  const dependencies = results.flatMap((result) =>
    result.dependencies.map((dependency) => ({
      assessmentId: result.assessmentId,
      ...dependency,
    })),
  );
  if (dependencies.length)
    await tx
      .insert(assessmentReadDependency)
      .values(dependencies)
      .onConflictDoNothing();
  const nextIndex = stage.nextIndex + results.length;
  await tx
    .update(assessmentReadStage)
    .set({ nextIndex })
    .where(eq(assessmentReadStage.id, stage.id));
  if (nextIndex !== stage.assessmentIds.length)
    return { kind: "retained", changed: [] };
  if (await stageInvalidated(db, stage))
    return { kind: "retained", changed: [] };
  const completed = await tx
    .selectDistinct({ id: assessmentReadPublication.assessmentId })
    .from(assessmentReadPublication)
    .where(eq(assessmentReadPublication.revision, stage.revision));
  if (
    JSON.stringify(completed.map(({ id }) => id).sort()) !==
    JSON.stringify([...stage.assessmentIds].sort())
  )
    throw new Error(
      "Assessment activation requires its complete staged member set",
    );
  const old = await tx
    .selectDistinct({
      id: assessmentReadPublication.assessmentId,
      revision: assessmentReadPublication.revision,
    })
    .from(assessmentReadPublication)
    .where(
      and(
        assessmentReadPublication.active,
        sql`${assessmentReadPublication.assessmentId} = ANY(${uuidArrayParam(stage.assessmentIds)})`,
      ),
    );
  const previousRevisions = [
    ...new Set([stage.revision, ...old.map((row) => row.revision)]),
  ];
  const changed = await tx
    .selectDistinct({ id: assessmentReadPublication.assessmentId })
    .from(assessmentReadPublication)
    .where(
      and(
        eq(assessmentReadPublication.revision, stage.revision),
        not(
          related(assessmentReadPublication, (active) =>
            and(
              active.active,
              eq(
                active.assessmentId,
                outer(assessmentReadPublication.assessmentId),
              ),
              eq(
                active.contentHash,
                outer(assessmentReadPublication.contentHash),
              ),
              eq(
                active.rulesVersion,
                outer(assessmentReadPublication.rulesVersion),
              ),
            )!,
          ).exists(),
        ),
      ),
    );
  const changedIds = changed.map((row) => row.id);
  if (changedIds.length) {
    // Every peer switches inside this transaction; no read observes half a winner group.
    await tx
      .update(assessmentReadPublication)
      .set({ active: false })
      .where(
        and(
          assessmentReadPublication.active,
          sql`${assessmentReadPublication.assessmentId} = ANY(${uuidArrayParam(changedIds)})`,
        ),
      );
    await tx
      .update(assessmentReadPublication)
      .set({ active: true, computedAt: sql`now()` })
      .where(
        and(
          eq(assessmentReadPublication.revision, stage.revision),
          sql`${assessmentReadPublication.assessmentId} = ANY(${uuidArrayParam(changedIds)})`,
        ),
      );
  }
  const dependencyRecords = () =>
    tx
      .selectDistinct({ entity: entityIdentity.kind, id: entityIdentity.id })
      .from(assessmentReadDependency)
      .innerJoin(
        entityIdentity,
        and(
          eq(entityIdentity.id, assessmentReadDependency.sourceId),
          eq(entityIdentity.kind, assessmentReadDependency.sourceKind),
        ),
      )
      .where(
        sql`${assessmentReadDependency.assessmentId} = ANY(${uuidArrayParam(changedIds)})`,
      );
  const oldDependencyRecords = changedIds.length
    ? await dependencyRecords()
    : [];
  // Keep old/provisional refs until the complete replacement is ready. Prune
  // only obsolete edges; unchanged dependencies need no rewrite, including when
  // a restarted stage leaves the active content hash unchanged.
  await tx.delete(assessmentReadDependency).where(
    and(
      sql`${assessmentReadDependency.assessmentId} = ANY(${uuidArrayParam(stage.assessmentIds)})`,
      not(
        related(assessmentReadPublication, (result) =>
          and(
            eq(result.revision, stage.revision),
            eq(
              result.assessmentId,
              outer(assessmentReadDependency.assessmentId),
            ),
            sql`${result.dependencies} @> jsonb_build_array(jsonb_build_object(
        'sourceKind', ${outer(assessmentReadDependency.sourceKind)}, 'sourceId', ${outer(assessmentReadDependency.sourceId)}::text))`,
          )!,
        ).exists(),
      ),
    ),
  );
  if (changedIds.length) {
    // The current and prior revisions coexist until notifications are captured.
    const inChangedRevision = and(
      sql`${assessmentReadMembership.assessmentId} = ANY(${uuidArrayParam(changedIds)})`,
      sql`${assessmentReadMembership.revision} = ANY(${uuidArrayParam(previousRevisions)})`,
    );
    const uuidType = "uuid";
    const records = await tx
      .selectDistinct({ entity: entityIdentity.kind, id: entityIdentity.id })
      .from(assessmentReadMembership)
      .innerJoin(
        entityIdentity,
        eq(entityIdentity.shortcode, assessmentReadMembership.value),
      )
      .where(and(inChangedRevision, eq(assessmentReadMembership.kind, "ref")))
      .union(
        tx
          .selectDistinct({
            entity: entityIdentity.kind,
            id: entityIdentity.id,
          })
          .from(assessmentReadMembership)
          .innerJoin(
            entityIdentity,
            and(
              eq(
                entityIdentity.id,
                sql`CASE WHEN pg_input_is_valid(${assessmentReadMembership.value}, ${uuidType}) THEN ${assessmentReadMembership.value}::uuid END`,
              ),
              eq(
                sql`${entityIdentity.id}::text`,
                assessmentReadMembership.value,
              ),
            ),
          )
          .where(
            and(inChangedRevision, eq(assessmentReadMembership.kind, "scope")),
          ),
      )
      .union(dependencyRecords());
    for (const record of [...oldDependencyRecords, ...records])
      publication.notify(record.entity, [record.id]);
  }
  await removeInactiveRevisions(db, stage.assessmentIds, previousRevisions);
  return { kind: "activated", changed: changedIds };
}

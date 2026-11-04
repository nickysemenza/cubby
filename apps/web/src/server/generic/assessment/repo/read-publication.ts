import {
  ASSESSMENT_READ_TARGET,
  assessmentReadResult,
  type AssessmentReadResult,
} from "@cubby/schemas/assessment-read-publication";
import type { Entity } from "@cubby/schemas/entity";
import { and, eq, not, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { uuidArrayParam } from "~/server/db/helpers/query";
import { outer, related } from "~/server/db/helpers/related";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  assessmentReadDependency,
  assessmentReadFact,
  assessmentReadMembership,
  assessmentReadPublication,
  assessmentReadStage,
  assessmentReadStageResult,
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
  /** The stage read before preparation; prevents replacing a different continuation. */
  previousStageId: string | null;
  results: readonly AssessmentReadResult[];
};

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

/** Abandoned staging never removes a revision that is still the read authority. */
async function removeInactiveRevisions(
  db: RepositoryQueryInput,
  ids: readonly string[],
  revisions: readonly string[],
) {
  for (const table of [assessmentReadFact, assessmentReadMembership])
    await repositoryQueries(db)
      .delete(table)
      .where(
        and(
          sql`${table.assessmentId} = ANY(${uuidArrayParam(ids)})`,
          sql`${table.revision} = ANY(${uuidArrayParam(revisions)})`,
          not(
            related(assessmentReadPublication, (header) =>
              and(
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
    if (existing.id !== prepared.previousStageId)
      return { kind: "retained", changed: [] };
    await tx
      .delete(assessmentReadStage)
      .where(eq(assessmentReadStage.id, existing.id));
    await removeInactiveRevisions(db, existing.assessmentIds, [
      existing.revision,
    ]);
  } else if (existing && existing.nextIndex !== stage.nextIndex) {
    return { kind: "retained", changed: [] };
  }
  if (await stageInvalidated(db, stage))
    return { kind: "retained", changed: [] };
  await tx.insert(assessmentReadStage).values(stage).onConflictDoNothing();
  if (stage.nextIndex === stage.assessmentIds.length)
    return { kind: "activated", changed: [] };
  if (!results.length)
    throw new Error("An incomplete Assessment stage must advance");
  const facts = results.flatMap((result) =>
    result.facts.map((fact) => ({
      assessmentId: result.assessmentId,
      revision: stage.revision,
      family: fact.key.family,
      key: fact.key,
      filters: fact.filters,
      row: fact.row,
    })),
  );
  const memberships = results.flatMap((result) =>
    result.memberships.map((membership, ordinal) => ({
      assessmentId: result.assessmentId,
      revision: stage.revision,
      ordinal,
      ...membership,
    })),
  );
  if (facts.length) await tx.insert(assessmentReadFact).values(facts);
  if (memberships.length)
    await tx.insert(assessmentReadMembership).values(memberships);
  const staged = await Promise.all(
    results.map(async (result) => ({
      stageId: stage.id,
      assessmentId: result.assessmentId,
      groupKey: result.groupKey,
      contentHash: await sha256CanonicalJson(result),
      admitted: result.facts.length > 0,
      dependencies: result.dependencies,
    })),
  );
  await tx.insert(assessmentReadStageResult).values(staged);
  const nextIndex = stage.nextIndex + results.length;
  await tx
    .update(assessmentReadStage)
    .set({ nextIndex })
    .where(eq(assessmentReadStage.id, stage.id));
  if (nextIndex !== stage.assessmentIds.length)
    return { kind: "retained", changed: [] };
  if (await stageInvalidated(db, stage))
    return { kind: "retained", changed: [] };
  const old = await tx
    .select({
      id: assessmentReadPublication.assessmentId,
      revision: assessmentReadPublication.revision,
    })
    .from(assessmentReadPublication)
    .where(
      sql`${assessmentReadPublication.assessmentId} = ANY(${uuidArrayParam(stage.assessmentIds)})`,
    );
  const previousRevisions = [
    ...new Set([stage.revision, ...old.map((row) => row.revision)]),
  ];
  const changed = await tx
    .insert(assessmentReadPublication)
    .select(
      tx
        .select({
          assessmentId: assessmentReadStageResult.assessmentId,
          revision: sql<string>`${stage.revision}::uuid`.as("revision"),
          rulesVersion: sql<number>`${stage.rulesVersion}::int`.as(
            "rulesVersion",
          ),
          contentHash: assessmentReadStageResult.contentHash,
          groupKey: assessmentReadStageResult.groupKey,
          admitted: assessmentReadStageResult.admitted,
          computedAt: sql<Date>`now()`.as("computedAt"),
        })
        .from(assessmentReadStageResult)
        .where(eq(assessmentReadStageResult.stageId, stage.id)),
    )
    .onConflictDoUpdate({
      target: assessmentReadPublication.assessmentId,
      set: {
        revision: sql`excluded.revision`,
        rulesVersion: sql`excluded."rulesVersion"`,
        contentHash: sql`excluded."contentHash"`,
        groupKey: sql`excluded."groupKey"`,
        admitted: sql`excluded.admitted`,
        computedAt: sql`excluded."computedAt"`,
      },
      setWhere: sql`${assessmentReadPublication.contentHash} IS DISTINCT FROM excluded."contentHash"
      OR ${assessmentReadPublication.rulesVersion} IS DISTINCT FROM excluded."rulesVersion"`,
    })
    .returning({ id: assessmentReadPublication.assessmentId });
  const changedIds = changed.map((row) => row.id);
  if (changedIds.length) {
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
    const oldDependencyRecords = await dependencyRecords();
    // Ineligible open proposals retain dependencies too. A dependency change is
    // part of the content hash; unchanged results perform no dependency writes.
    await tx
      .delete(assessmentReadDependency)
      .where(
        sql`${assessmentReadDependency.assessmentId} = ANY(${uuidArrayParam(changedIds)})`,
      );
    const stagedDependencies = alias(
      assessmentReadStageResult,
      "staged_dependencies",
    );
    await tx.insert(assessmentReadDependency).select(
      tx
        .selectDistinct({
          assessmentId: stagedDependencies.assessmentId,
          sourceKind: sql<string>`d."sourceKind"`.as("sourceKind"),
          sourceId: sql<string>`d."sourceId"`.as("sourceId"),
        })
        .from(stagedDependencies)
        .innerJoinLateral(
          sql`jsonb_to_recordset(${stagedDependencies.dependencies}) AS d("sourceKind" text, "sourceId" uuid)`,
          sql`true`,
        )
        .where(
          and(
            eq(stagedDependencies.stageId, stage.id),
            sql`${stagedDependencies.assessmentId} = ANY(${uuidArrayParam(changedIds)})`,
          ),
        ),
    );
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
  await tx
    .delete(assessmentReadStageResult)
    .where(eq(assessmentReadStageResult.stageId, stage.id));
  return { kind: "activated", changed: changedIds };
}

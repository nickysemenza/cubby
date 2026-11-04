import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import {
  ASSESSMENT_READ_TARGET,
  ASSESSMENT_READ_RULES_VERSION,
  assessmentReadResult,
  type AssessmentReadResult,
} from "@cubby/schemas/assessment-read-publication";
import type { Entity } from "@cubby/schemas/entity";
import {
  suggestionListFamily,
  type SuggestionListFamily,
} from "@cubby/schemas/suggestion-list";
import {
  and,
  arrayOverlaps,
  eq,
  inArray,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
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
  assessment,
  assessmentState,
  entityIdentity,
} from "~/server/db/retained-tables";
import { automaticApplicationRule } from "~/server/generic/assessment/repo/assessment";
import {
  publishedSuggestionLiveEligibility,
  type AssessmentRecordSelection,
} from "~/server/generic/assessment/repo/pending-admission";
import { fanoutTargetMatches } from "~/server/generic/derived/repo/fanout";
import {
  pendingWorkStatusSql,
  unobservedWork,
} from "~/server/generic/jobs/repo/work-items";
import { sha256CanonicalJson } from "~/server/lib/canonical-json";

export type AssessmentPublishedScope = Pick<
  AssessmentRecordSelection,
  "entity" | "records"
> & {
  families?: readonly SuggestionListFamily[];
};

/**
 * Shared relational admission for pending browse consumers. It reads normalized
 * publications and current authority only; no evidence capture or enrollment.
 */
export function publishedAssessmentAdmissionSql(
  scope: AssessmentPublishedScope = {},
): SQL {
  const families = scope.families ?? suggestionListFamily.options;
  const selectedFamilies = families.length
    ? sql`IN (${sql.join(
        families.map((family) => sql`${family}`),
        sql`, `,
      )})`
    : sql`IN (NULL)`;
  const scoped = scope.entity !== undefined || scope.records !== undefined;
  // Scope records drive fenced hash-assisted point probes. Exact text remains
  // authoritative, including malformed and non-canonical historical tokens.
  const membershipFrom =
    scope.records !== undefined
      ? sql`jsonb_to_recordset(${JSON.stringify(scope.records)}::jsonb)
        AS requested(entity text, id text, code text)
      CROSS JOIN LATERAL (
        SELECT indexed."assessmentId", indexed.revision, indexed."stateFamily", indexed.retained, indexed.entity
        FROM ${assessmentReadMembership} indexed
        WHERE indexed.kind = 'scope' AND indexed.entity = requested.entity
          AND md5(indexed.value) IN (md5(requested.id), md5(requested.code))
          AND indexed.value IN (requested.id, requested.code)
        OFFSET 0
      ) m`
      : sql`${assessmentReadMembership} m`;
  const discovery = sql`SELECT DISTINCT m."assessmentId", m."stateFamily"
    FROM ${membershipFrom}
    JOIN ${assessmentReadPublication} membership_publication
      ON membership_publication."assessmentId" = m."assessmentId"
      AND membership_publication.revision = m.revision AND membership_publication.active
    JOIN ${assessment} discovery_assessment ON discovery_assessment.id = m."assessmentId" AND discovery_assessment.served
    JOIN ${assessmentState} discovery_state ON discovery_state.id = m."assessmentId"
      AND discovery_state.active AND discovery_state.status = ${suggestionStatus.enum.pending}
    WHERE ${scope.records !== undefined ? sql`true` : sql`m.kind = 'scope'`} AND m."stateFamily" ${selectedFamilies}
      ${scope.entity === undefined ? sql`` : sql`AND (m.retained OR m.entity = ${scope.entity})`}`;
  return sql`${scoped ? sql`WITH discovered AS MATERIALIZED (${discovery})` : sql``}
    SELECT p."assessmentId", p.revision, p.family, p.key, p.filters, p.row, p."computedAt", p."rulesVersion"
    FROM ${assessmentReadPublication} p
    JOIN ${assessment} a ON a.id = p."assessmentId"
    JOIN ${assessmentState} s ON s.id = p."assessmentId"
    WHERE p.active AND p.admitted AND p.family ${selectedFamilies}
      AND ${publishedSuggestionLiveEligibility(sql`p.family`)}
      AND CASE WHEN p.family IN (${assessmentFamily.enum.field}, ${assessmentFamily.enum.statement_transaction})
        THEN ${automaticApplicationRule(sql`a.id`)} IS NULL ELSE true END
      ${
        scoped
          ? sql`AND p."assessmentId" IN (SELECT "assessmentId" FROM discovered)
        AND p.family IN (SELECT "stateFamily" FROM discovered)`
          : sql``
      }`;
}

/**
 * Count references once per Assessment, even when family authorities diverge.
 * Ordinal retains duplicate references; families remains available to Work.
 */
export function publishedAssessmentRecordRefsSql(
  scope: AssessmentPublishedScope = {},
): SQL {
  return sql`SELECT admitted."assessmentId", admitted.families, m.entity,
      m.value AS "recordCode", m.ordinal
    FROM (SELECT "assessmentId", revision, array_agg(DISTINCT family) AS families
      FROM (${publishedAssessmentAdmissionSql(scope)}) facts
      GROUP BY "assessmentId", revision) admitted
    JOIN ${assessmentReadMembership} m ON m."assessmentId" = admitted."assessmentId"
      AND m.revision = admitted.revision AND m.kind = 'ref'`;
}

/**
 * Before expansion, new memberships are unknown. Coverage therefore stays
 * conservative across scopes instead of claiming that an empty scoped read is
 * complete. Empty successful revisions do establish coverage for their source.
 */
export function publishedAssessmentCoverageSql(): SQL {
  const families = sql.join(
    suggestionListFamily.options.map((family) => sql`${family}`),
    sql`, `,
  );
  const population = sql`SELECT s.id FROM ${assessmentState} s
    JOIN ${assessment} a ON a.id = s.id
    WHERE s.active AND s.status = ${suggestionStatus.enum.pending}
      AND (s.family IN (${families}) OR a.family IN (${families}))
      AND (a.served OR s.family IN (${assessmentFamily.enum.statement_transaction}, ${assessmentFamily.enum.transfer_pair}))`;
  return sql`SELECT
    EXISTS (SELECT 1 FROM (${population}) open
      WHERE NOT EXISTS (SELECT 1 FROM ${assessmentReadPublication} p
        WHERE p."assessmentId" = open.id AND p.active)) AS missing,
    (EXISTS (SELECT 1 FROM (${population}) open
      JOIN ${assessmentReadPublication} p ON p."assessmentId" = open.id AND p.active
      WHERE p."rulesVersion" <> ${ASSESSMENT_READ_RULES_VERSION})
      OR (work.count > 0 AND EXISTS (SELECT 1 FROM ${assessmentReadPublication} p WHERE p.active))) AS stale,
    work.count > 0 AS unresolved, work.failed > 0 AS failed
    FROM ${pendingWorkStatusSql((target) =>
      or(
        eq(target, ASSESSMENT_READ_TARGET),
        fanoutTargetMatches(target, sql`${ASSESSMENT_READ_TARGET}::text`),
      )!,
    )} work`;
}

export type AssessmentReadStagePlan = Omit<
  typeof assessmentReadStage.$inferSelect,
  "createdAt"
>;
export type AssessmentReadStageWrite = {
  stage: AssessmentReadStagePlan;
  /** Exact continuations observed before preparation, including components that merged. */
  previousStageIds: readonly string[];
  results: readonly AssessmentReadResult[];
  sourceScope?: (source: { target: SQL; ref: SQL }) => SQL;
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

const publicationActivityBucket = z.object({
  age: z.number().int(),
  count: z.number().int(),
});

/** One successful revision counts once, including empty results and multiple family rows. */
export async function readAssessmentPublicationActivity(
  db: RepositoryQueryInput,
  windowMinutes: number,
): Promise<z.infer<typeof publicationActivityBucket>[]> {
  const rows = await repositoryQueries(db).execute(sql`
    SELECT floor(extract(epoch FROM now() - ${assessmentReadPublication.computedAt}) / 60)::int AS age,
      count(DISTINCT (${assessmentReadPublication.assessmentId}, ${assessmentReadPublication.revision}))::int AS count
    FROM ${assessmentReadPublication}
    WHERE ${assessmentReadPublication.active}
      AND ${assessmentReadPublication.computedAt} > now() - ${windowMinutes} * interval '1 minute'
    GROUP BY 1`);
  return publicationActivityBucket.array().parse(rows.rows);
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
function assessmentReadStageBlocked(
  stage: AssessmentReadStagePlan,
  sourceScope: AssessmentReadStageWrite["sourceScope"],
): SQL {
  return unobservedWork(
    (target, ref) =>
      or(
        eq(target, ASSESSMENT_READ_TARGET),
        and(
          fanoutTargetMatches(target, sql`${ASSESSMENT_READ_TARGET}::text`),
          sourceScope?.({ target, ref }),
        ),
      )!,
    stage.tickets.map((item) => item.ticket),
    { target: ASSESSMENT_READ_TARGET, refs: stage.assessmentIds },
  );
}

async function stageInvalidated(
  db: RepositoryQueryInput,
  stage: AssessmentReadStagePlan,
  sourceScope: AssessmentReadStageWrite["sourceScope"],
) {
  const rows = await repositoryQueries(db).execute(
    sql`SELECT ${assessmentReadStageBlocked(stage, sourceScope)} AS invalidated`,
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
  if (existing?.id === stage.id) {
    // Later chunks may hold other peers from this exact applied generation.
    // Acknowledging it never clears a newer ticket; the generic owner does CAS.
    if (existing.nextIndex === existing.assessmentIds.length)
      return { kind: "activated", changed: [] };
    if (existing.nextIndex !== stage.nextIndex)
      return { kind: "retained", changed: [] };
  }
  if (await stageInvalidated(db, stage, prepared.sourceScope))
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
  if (await stageInvalidated(db, stage, prepared.sourceScope))
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

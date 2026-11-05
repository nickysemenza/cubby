import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import {
  ASSESSMENT_READ_TARGET,
  ASSESSMENT_READ_RULES_VERSION,
  assessmentReadResult,
  assessmentReadScopedSourceKind,
  type AssessmentReadResult,
} from "@cubby/schemas/assessment-read-publication";
import { entitySchema, type Entity } from "@cubby/schemas/entity";
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
import { uuidArrayParam, householdDaySql } from "~/server/db/helpers/query";
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
import { emailPurchaseSourceIdsSql } from "~/server/domains/email/repo/email-purchase-links";
import {
  transferPairSourceAssessmentIdsSql,
  recordedTransferSourceIdsSql,
} from "~/server/domains/financial-transaction/repo/transfer-pair-input";
import { settlementCandidatePurchaseIdsSql } from "~/server/domains/purchase/repo/settlement-predicates";
import { statementSourceAssessmentIdsSql } from "~/server/domains/transaction-import/repo/statement-charge";
import { automaticApplicationRule } from "~/server/generic/assessment/repo/assessment";
import { fieldInputAssessmentIdsSql } from "~/server/generic/assessment/repo/field-input-fence";
import {
  publishedSuggestionLiveEligibility,
  assessmentSourceRecordIdsSql,
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
  const discovery = sql`SELECT DISTINCT m."assessmentId", m."stateFamily", discovery_assessment.family AS "immutableFamily"
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
        AND p.family IN (SELECT "stateFamily" FROM discovered UNION SELECT "immutableFamily" FROM discovered)`
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

/** Preparation and coverage share the same served/open population. */
function assessmentReadPopulationSql(ids?: readonly string[]): SQL {
  const families = sql.join(
    suggestionListFamily.options.map((family) => sql`${family}`),
    sql`, `,
  );
  return sql`SELECT s.id FROM ${assessmentState} s
    JOIN ${assessment} a ON a.id = s.id
    WHERE s.active AND s.status = ${suggestionStatus.enum.pending}
      AND (s.family IN (${families}) OR a.family IN (${families}))
      AND (a.served OR s.family IN (${assessmentFamily.enum.statement_transaction}, ${assessmentFamily.enum.transfer_pair}))
      ${ids === undefined ? sql`` : sql`AND s.id = ANY(${uuidArrayParam(ids)})`}`;
}

/**
 * Before expansion, new memberships are unknown. Coverage therefore stays
 * conservative across scopes instead of claiming that an empty scoped read is
 * complete. Empty successful revisions do establish coverage for their source.
 */
export function publishedAssessmentCoverageSql(): SQL {
  const population = assessmentReadPopulationSql();
  return sql`SELECT
    EXISTS (SELECT 1 FROM (${population}) open
      WHERE NOT EXISTS (SELECT 1 FROM ${assessmentReadPublication} p
        WHERE p."assessmentId" = open.id AND p.active)) AS missing,
    (EXISTS (SELECT 1 FROM (${population}) open
      JOIN ${assessmentReadPublication} p ON p."assessmentId" = open.id AND p.active
      WHERE p."rulesVersion" <> ${ASSESSMENT_READ_RULES_VERSION})
      OR (work.count > 0 AND EXISTS (SELECT 1 FROM ${assessmentReadPublication} p WHERE p.active))
      OR EXISTS (${expiredAssessmentPublicationClockSql()})) AS stale,
    work.count > 0 AS unresolved, work.failed > 0 AS failed
    FROM ${pendingWorkStatusSql((target) =>
      or(
        eq(target, ASSESSMENT_READ_TARGET),
        fanoutTargetMatches(target, sql`${ASSESSMENT_READ_TARGET}::text`),
      )!,
    )} work`;
}

const currentAssessmentClockDay = householdDaySql(
  sql`clock_timestamp() AT TIME ZONE 'UTC'`,
);

/** Empty successful results also expire: immutable scope owns clock sensitivity. */
export function expiredAssessmentPublicationClockSql(
  day: SQL = currentAssessmentClockDay,
): SQL {
  return sql`SELECT DISTINCT a.id FROM ${assessment} a
    JOIN ${assessmentState} s ON s.id = a.id
    JOIN ${assessmentReadPublication} p ON p."assessmentId" = a.id AND p.active
    WHERE a.served AND a.family = ${assessmentFamily.enum.recommendation}
      AND a.subject->>'scope' = ${"connection.project-tool"}
      AND s.active AND s.status = ${suggestionStatus.enum.pending}
      AND p."clockDay" IS DISTINCT FROM ${day}`;
}

/** Retained inputs and current field references share one indexed expansion owner. */
export function assessmentReadSourceSelection(
  sourceKind: string,
  refs: SQL,
): SQL {
  if (sourceKind === "projectRoster" || sourceKind === "projectTools")
    return sql`SELECT a.id FROM ${assessment} a JOIN ${assessmentState} s ON s.id = a.id
      WHERE a.served AND s.active AND s.status = ${suggestionStatus.enum.pending}
        AND a.family = ${assessmentFamily.enum.recommendation}
        AND a.subject->>'scope' IN (${
          sourceKind === "projectRoster"
            ? sql`${"connection.expense-project"}, ${"connection.project-tool"}`
            : sql`${"connection.project-tool"}`
        })`;
  if (sourceKind === "transferPolicy")
    return transferPairSourceAssessmentIdsSql("policy", refs);
  if (sourceKind === "emailPurchase")
    return sql`(${assessmentReadSourceSelection(entitySchema.enum.purchase, refs)})
      UNION (${assessmentReadSourceSelection(entitySchema.enum.email, emailPurchaseSourceIdsSql(refs))})`;
  if (sourceKind === "settlementPolicy")
    return sql`SELECT s.id FROM ${assessmentState} s JOIN ${assessment} a ON a.id = s.id
      WHERE s.active AND s.status = ${suggestionStatus.enum.pending} AND a.served
        AND a.family = ${assessmentFamily.enum.recommendation}
        AND a.subject->>'scope' IN (${"connection.transaction-purchase"}, ${"connection.transaction-refund"})`;
  const families = sql.join(
    suggestionListFamily.options.map((family) => sql`${family}`),
    sql`, `,
  );
  if (sourceKind === "assessment")
    return sql`WITH assessment_source_refs AS MATERIALIZED (${refs})
      SELECT a.id FROM ${assessment} a LEFT JOIN ${assessmentState} s ON s.id = a.id
      WHERE a.id IN (SELECT id FROM assessment_source_refs)
        AND ((a.served AND (a.family IN (${families}) OR s.family IN (${families})))
          OR s.family IN (${assessmentFamily.enum.statement_transaction}, ${assessmentFamily.enum.transfer_pair})
          OR EXISTS (SELECT 1 FROM ${assessmentReadPublication} p WHERE p."assessmentId" = a.id))`;
  if (sourceKind === "productQuality")
    return sql`WITH assessment_source_refs AS MATERIALIZED (${refs})
      SELECT s.id FROM ${assessmentState} s JOIN ${assessment} a ON a.id = s.id
      WHERE a.served AND s.active AND s.status = ${suggestionStatus.enum.pending}
        AND (a.family = ${assessmentFamily.enum.product_pair} OR s.family = ${assessmentFamily.enum.product_pair})
        AND (s."recordId" IN (SELECT id FROM assessment_source_refs)
          OR CASE WHEN pg_input_is_valid(s.data->>'otherId', ${"uuid"}) THEN (s.data->>'otherId')::uuid END IN (SELECT id FROM assessment_source_refs)
          OR a.subject->>'otherId' IN (SELECT id::text FROM assessment_source_refs)
          OR EXISTS (SELECT 1 FROM ${assessmentReadDependency} d WHERE d."assessmentId" = s.id
            AND d."sourceKind" = ${entitySchema.enum.product} AND d."sourceId" IN (SELECT id FROM assessment_source_refs)))`;
  if (sourceKind === "pairPolicy")
    // Identifier issuers are resolved by the whole registry, including URL hosts
    // that have no prior FK or reverse dependency on this Product pair.
    return sql`SELECT a.id FROM ${assessment} a JOIN ${assessmentState} s ON s.id = a.id
      WHERE a.served AND s.active AND s.status = ${suggestionStatus.enum.pending}
        AND (a.family = ${assessmentFamily.enum.product_pair} OR s.family = ${assessmentFamily.enum.product_pair})`;
  if (sourceKind === "classificationRoster")
    return sql`SELECT d."assessmentId" AS id FROM ${assessmentReadDependency} d
      WHERE d."sourceKind" = ${assessmentReadScopedSourceKind.enum.productClassification}
      UNION SELECT a.id FROM ${assessment} a JOIN ${assessmentState} s ON s.id = a.id
        WHERE a.served AND s.active AND s.status = ${suggestionStatus.enum.pending}
          AND (a.family = ${assessmentFamily.enum.product_pair} OR s.family = ${assessmentFamily.enum.product_pair})
      UNION (${fieldInputAssessmentIdsSql(
        assessmentReadScopedSourceKind.enum.productClassification,
        sql`SELECT id FROM ${entityIdentity} WHERE kind = ${entitySchema.enum.product}`,
      )})`;
  const entityInput = entitySchema.safeParse(sourceKind);
  if (
    !entityInput.success &&
    !assessmentReadScopedSourceKind.safeParse(sourceKind).success
  )
    throw new Error(`Unknown Assessment source selection: ${sourceKind}`);
  const retained = sql`SELECT d."assessmentId" AS id FROM ${assessmentReadDependency} d
    WHERE d."sourceKind" = ${sourceKind} AND d."sourceId" IN (SELECT id FROM assessment_source_refs)`;
  const forward =
    entityInput.success ||
    sourceKind === assessmentReadScopedSourceKind.enum.fieldWrite ||
    sourceKind === assessmentReadScopedSourceKind.enum.productClassification
      ? fieldInputAssessmentIdsSql(
          sourceKind,
          sql`SELECT id FROM assessment_source_refs`,
        )
      : sql`SELECT NULL::uuid AS id WHERE false`;
  const pairEndpoints =
    sourceKind === entitySchema.enum.product
      ? assessmentReadSourceSelection("productQuality", refs)
      : sql`SELECT NULL::uuid AS id WHERE false`;
  const statementInputs =
    sourceKind === entitySchema.enum.sourceTransactionRecord ||
    sourceKind === entitySchema.enum.financialTransaction ||
    sourceKind === entitySchema.enum.financialAccount ||
    sourceKind === entitySchema.enum.ledgerParty
      ? statementSourceAssessmentIdsSql(sourceKind, refs)
      : sql`SELECT NULL::uuid AS id WHERE false`;
  const transferInputs =
    sourceKind === entitySchema.enum.financialTransaction ||
    sourceKind === entitySchema.enum.sourceTransactionRecord
      ? transferPairSourceAssessmentIdsSql(sourceKind, refs)
      : sql`SELECT NULL::uuid AS id WHERE false`;
  const currentRecords = entityInput.success
    ? assessmentSourceRecordIdsSql(entityInput.data, refs)
    : sql`SELECT NULL::uuid AS id WHERE false`;
  const settlementInputs =
    sourceKind === entitySchema.enum.financialTransaction
      ? assessmentSourceRecordIdsSql(
          entitySchema.enum.purchase,
          settlementCandidatePurchaseIdsSql(refs),
        )
      : sql`SELECT NULL::uuid AS id WHERE false`;
  const recordedTransferInputs =
    sourceKind === entitySchema.enum.financialTransaction
      ? sql`SELECT affected.id FROM (${assessmentSourceRecordIdsSql(entitySchema.enum.financialTransaction, recordedTransferSourceIdsSql(refs))}) affected
        JOIN ${assessment} a ON a.id = affected.id
        WHERE a.subject->>'scope' = ${"connection.transaction-transfer"}`
      : sql`SELECT NULL::uuid AS id WHERE false`;
  // The full Expense-project roster has separate column-scoped captures.
  // Generic edits may change shared tool availability or presentation; new
  // candidates need this small roster even before reverse dependencies exist.
  const projectToolInputs = [
    entitySchema.enum.expense,
    entitySchema.enum.purchase,
    entitySchema.enum.project,
    entitySchema.enum.task,
    entitySchema.enum.product,
    entitySchema.enum.productCategory,
    entitySchema.enum.inventory,
    entitySchema.enum.vendor,
    entitySchema.enum.spendingCategory,
  ].some((kind) => kind === sourceKind)
    ? assessmentReadSourceSelection("projectTools", refs)
    : sql`SELECT NULL::uuid AS id WHERE false`;
  return sql`WITH assessment_source_refs AS MATERIALIZED (${refs})
    ${retained} UNION (${forward}) UNION (${pairEndpoints}) UNION (${statementInputs}) UNION (${transferInputs}) UNION (${currentRecords}) UNION (${settlementInputs}) UNION (${recordedTransferInputs}) UNION (${projectToolInputs})`;
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
  const result = await repositoryQueries(db).execute(
    assessmentReadPopulationSql(ids),
  );
  return z
    .array(z.object({ id: z.guid() }))
    .parse(result.rows)
    .map((row) => row.id);
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
export function assessmentReadStageBlocked(
  stage: AssessmentReadStagePlan,
  sourceScope: AssessmentReadStageWrite["sourceScope"],
): SQL {
  return or(
    stage.clockDay === null
      ? undefined
      : sql`${stage.clockDay}::date IS DISTINCT FROM ${currentAssessmentClockDay}`,
    unobservedWork(
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
    ),
  )!;
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
      existing.clockDay !== stage.clockDay ||
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
        clockDay: stage.clockDay,
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
  if (await stageInvalidated(db, stage, prepared.sourceScope)) {
    // A completed cursor acknowledges activation, not just prepared rows. Keep
    // the recovery roster but discard every stale prefix, even if the source
    // ticket is cancelled before this component is retried.
    await removeInactiveRevisions(db, stage.assessmentIds, [stage.revision]);
    await tx
      .update(assessmentReadStage)
      .set({ nextIndex: 0 })
      .where(eq(assessmentReadStage.id, stage.id));
    return { kind: "retained", changed: [] };
  }
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
  // Verification day advances on successful no-op completion, while content
  // identity and publication-age telemetry retain their original meaning.
  if (stage.clockDay !== null)
    await tx
      .update(assessmentReadPublication)
      .set({ clockDay: stage.clockDay })
      .where(
        and(
          assessmentReadPublication.active,
          sql`${assessmentReadPublication.assessmentId} = ANY(${uuidArrayParam(stage.assessmentIds)})`,
          sql`${assessmentReadPublication.clockDay} IS DISTINCT FROM ${stage.clockDay}::date`,
        ),
      );
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
        sql`${assessmentReadDependency.assessmentId} = ANY(${uuidArrayParam(stage.assessmentIds)})`,
      );
  const oldDependencyRecords = await dependencyRecords();
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
  // Completion changes coverage even when the retained content is identical.
  // The current and prior revisions coexist until notifications are captured.
  const inCompletedRevision = and(
    sql`${assessmentReadMembership.assessmentId} = ANY(${uuidArrayParam(stage.assessmentIds)})`,
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
    .where(and(inCompletedRevision, eq(assessmentReadMembership.kind, "ref")))
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
            eq(sql`${entityIdentity.id}::text`, assessmentReadMembership.value),
          ),
        )
        .where(
          and(inCompletedRevision, eq(assessmentReadMembership.kind, "scope")),
        ),
    )
    .union(dependencyRecords());
  for (const record of [...oldDependencyRecords, ...records])
    publication.notify(record.entity, [record.id]);
  await removeInactiveRevisions(db, stage.assessmentIds, previousRevisions);
  return { kind: "activated", changed: changedIds };
}

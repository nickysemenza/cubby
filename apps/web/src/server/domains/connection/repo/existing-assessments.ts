import {
  type AssessmentProducer,
  type EntityPairAssessmentFamily,
  entityPairAssessmentFamilies,
  isEntityPairAssessmentFamily,
} from "@cubby/schemas/assessment";
import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionProposal,
  connectionEdge,
  connectionEdgeKey,
  type ConnectionEdge,
  type ConnectionProposal,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";
import { PRODUCT_PAIR_NOT_ACTIONABLE } from "@cubby/schemas/recommendations";
import { and, eq, inArray, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted, uuidArrayParam } from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import {
  assessment,
  assessmentState,
  entityIdentity,
  feedback,
} from "~/server/db/schema";
import { currentProductPairPolicy } from "~/server/domains/product/repo/match/product-match-candidate";
import { readStoredProductPair } from "~/server/domains/product/repo/match/product-pair-signals";

import {
  connectionReadEvidence,
  connectionReadEvidenceSql,
  connectionBasisIsCurrent,
  forEachConnectionBasis,
} from "./connection-evidence";

const fieldRelations = new Map<string, ConnectionRelation>(
  Object.entries({
    "task.subjectProductId": "task-subject-product",
    "product.ingredientId": "product-ingredient",
    "product.growsPlantId": "product-grows-plant",
    "cookbook.productId": "cookbook-product",
    "device.productId": "device-product",
    "expense.productId": "product-expense",
    "expense.projectId": "expense-project",
    "inventory.locationId": "inventory-location",
  } satisfies Record<string, ConnectionRelation>),
);
/**
 * Review presentation per entity-pair family. A pair that is not actionable or
 * carries an identity conflict stays visible with its stored reason; the
 * family's review surface owns whether it can merge.
 */
const pairFamilies = {
  product_pair: {
    relation: "product-identity",
    integration: { kind: "product-pair-review" },
    current: currentProductPairPolicy,
    explain: (evidence: unknown) => {
      const stored = readStoredProductPair(evidence);
      return {
        reason: stored.evidence,
        conflicts: stored.conflictReasons,
        notActionable: PRODUCT_PAIR_NOT_ACTIONABLE,
      };
    },
  },
} satisfies Record<
  EntityPairAssessmentFamily,
  {
    relation: ConnectionRelation;
    integration: ConnectionProposal["integration"];
    current: (producer: AssessmentProducer | null) => boolean;
    explain: (evidence: unknown) => {
      reason: string | null;
      conflicts: string[];
      /** Unknown shown when the judgment is not actionable. */
      notActionable: string;
    };
  }
>;
const pairFamilyList = sql.join(
  entityPairAssessmentFamilies.map((family) => sql`${family}`),
  sql`, `,
);
const key = (source: EntityRef) => `${source.entityKind}:${source.entityId}`;
const canonicalPairTargetId = (
  value: SQL,
) => sql`CASE WHEN ${value} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (${value})::uuid END`;

/** Indexed potential membership, before mutable eligibility and evidence guards. */
function existingConnectionAssessmentIds(
  db: Database,
  sources: readonly EntityRef[],
) {
  const keys = sources.map(key);
  const codes = sql.join(
    [...new Set(sources.map((source) => source.entityId))].map(
      (code) => sql`${code}`,
    ),
    sql`, `,
  );
  const codeHashes = sql.join(
    [...new Set(sources.map((source) => source.entityId))].map(
      (code) => sql`md5(${code})`,
    ),
    sql`, `,
  );
  const sourceIds = sql`SELECT source_entity."id" FROM "Entity" source_entity
    WHERE source_entity."shortcode" IN (${codes})
      AND ${inArray(sql`source_entity."kind" || ':' || source_entity."shortcode"`, keys)}`;
  // Literal boolean gates let generic plans prove the partial-index predicates.
  const pendingState = and(
    assessmentState.active,
    eq(assessmentState.status, "pending"),
  );
  const idsFor = (families: "all" | "pair", match: SQL) =>
    getDb(db)
      .select({ id: assessment.id })
      .from(assessment)
      .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
      .where(
        and(
          assessment.served,
          pendingState,
          inArray(
            assessment.family,
            families === "all"
              ? ["field", ...entityPairAssessmentFamilies]
              : entityPairAssessmentFamilies,
          ),
          match,
        ),
      );
  const fieldMembership = sql.identifier("existing_field_membership");
  const fieldPublication = related(assessment, (publication) =>
    eq(publication.id, outer(assessmentState.id)),
  )
    .where((publication) =>
      and(publication.served, eq(publication.family, "field")),
    )
    .aggregate(
      (publication) => sql`${publication.id} AS ${sql.identifier("id")}`,
    );
  // Match indexed State identities before loading immutable family authority.
  const fieldIds = getDb(db)
    .select({
      id: sql<
        typeof assessment.$inferSelect.id
      >`${fieldMembership}.${sql.identifier("id")}`,
    })
    .from(assessmentState)
    .innerJoinLateral(
      sql`(${fieldPublication} OFFSET 0) AS ${fieldMembership}`,
      sql`true`,
    )
    .where(
      and(
        pendingState,
        // Exact equality remains authoritative for arbitrary historical text.
        sql`md5(${assessmentState.suggestedValue} #>> '{}') IN (${codeHashes})
          AND ${assessmentState.suggestedValue} #>> '{}' IN (${codes})`,
      ),
    );
  const requestedPairs = sql.identifier("existing_pair_requested");
  const pairMembership = sql.identifier("existing_pair_membership");
  const requestedPairId = sql`${requestedPairs}.${sql.identifier("id")}`;
  const pairPointQuery = idsFor(
    "pair",
    sql`${assessment.subject}->>'otherId' IS NOT NULL
      AND md5(${assessment.subject}->>'otherId') = md5(${requestedPairId}::text)
      AND ${assessment.subject}->>'otherId' = ${requestedPairId}::text`,
  );
  // Each endpoint can match many publications. Keep its indexed identity probe
  // parameterized rather than hashing the pair population for a large roster.
  const pairIds = getDb(db)
    .select({
      id: sql<
        typeof assessment.$inferSelect.id
      >`${pairMembership}.${sql.identifier("id")}`,
    })
    .from(sql`(${sourceIds}) AS ${requestedPairs}`)
    .innerJoinLateral(
      sql`(${pairPointQuery.getSQL()} OFFSET 0) AS ${pairMembership}`,
      sql`true`,
    );
  return idsFor(
    "all",
    sql`
    ${inArray(assessmentState.entity, [...new Set(sources.map((source) => source.entityKind))])}
    AND ${assessmentState.recordId} IN (${sourceIds})`,
  )
    .union(fieldIds)
    .union(pairIds);
}

/** Group preparation includes ineligible peers that can revive after an input change. */
export async function readPotentialConnectionAssessmentIds(
  db: Database,
  sources: readonly EntityRef[],
): Promise<string[]> {
  if (!sources.length) return [];
  const candidates = existingConnectionAssessmentIds(db, sources).as(
    "potential_connection_assessments",
  );
  return (await getDb(db).select({ id: candidates.id }).from(candidates)).map(
    (row) => row.id,
  );
}

/** Source-first barrier shared by selected retrieval and publication grouping. */
function connectionSourcePeers(db: Database, sourceKind: SQL, sourceCode: SQL) {
  const indexed = alias(assessment, "connection_peer_indexed");
  return getDb(db)
    .select({ id: indexed.id, evidence: indexed.evidence })
    .from(indexed)
    .where(
      and(
        indexed.served,
        sql`${indexed.subject}->>'scope' LIKE 'connection.%'`,
        sql`${indexed.evidence} #>> '{candidate,source,entityKind}' = ${sourceKind}`,
        sql`${indexed.evidence} #>> '{candidate,source,entityId}' = ${sourceCode}`,
      ),
    );
}

/** Preserve raw selected tuples even when the selected publication is ineligible. */
export async function readSelectedConnectionAssessmentIds(
  db: Database,
  reviewIds: readonly string[],
): Promise<string[]> {
  if (!reviewIds.length) return [];
  const selected = alias(assessment, "selected_connection");
  const matched = sql.identifier("connection_edge");
  const evidence = sql`${matched}.${sql.identifier("evidence")}`;
  const point = connectionSourcePeers(
    db,
    sql`${outer(selected.evidence)} #>> '{candidate,source,entityKind}'`,
    sql`${outer(selected.evidence)} #>> '{candidate,source,entityId}'`,
  );
  const rows = await getDb(db)
    .selectDistinct({ id: sql<string>`${matched}.${sql.identifier("id")}` })
    .from(selected)
    .innerJoinLateral(
      sql`(${point.getSQL()} OFFSET 0) AS ${matched}`,
      sql`true`,
    )
    .where(
      and(
        sql`${selected.id} = ANY(${uuidArrayParam(reviewIds)})`,
        sql`(${evidence}#>>'{candidate,relation}', ${evidence}#>>'{candidate,target,entityKind}', ${evidence}#>>'{candidate,target,entityId}') =
        (${selected.evidence}#>>'{candidate,relation}', ${selected.evidence}#>>'{candidate,target,entityKind}', ${selected.evidence}#>>'{candidate,target,entityId}')`,
      ),
    );
  return rows.map((row) => row.id);
}

/** Peers on exact edges, including stale competitors, before family admission. */
export async function readConnectionEdgeAssessmentIds(
  db: Database,
  edges: readonly ConnectionEdge[],
): Promise<string[]> {
  if (!edges.length) return [];
  const distinct = [
    ...new Map(edges.map((edge) => [connectionEdgeKey(edge), edge])).values(),
  ];
  const requested = sql.identifier("edge_requested");
  const matched = sql.identifier("edge_membership");
  const column = (name: string) => sql`${requested}.${sql.identifier(name)}`;
  const point = connectionSourcePeers(
    db,
    column("sourceKind"),
    column("sourceCode"),
  );
  const evidence = sql`${matched}.${sql.identifier("evidence")}`;
  const rows = await getDb(db)
    .selectDistinct({ id: sql<string>`${matched}.${sql.identifier("id")}` })
    .from(
      sql`jsonb_to_recordset(${JSON.stringify(
        distinct.map((edge) => ({
          relation: edge.relation,
          sourceKind: edge.source.entityKind,
          sourceCode: edge.source.entityId,
          targetKind: edge.target.entityKind,
          targetCode: edge.target.entityId,
        })),
      )}::jsonb) AS ${requested}(relation text, "sourceKind" text, "sourceCode" text, "targetKind" text, "targetCode" text)`,
    )
    .innerJoinLateral(
      sql`(${point.getSQL()} OFFSET 0) AS ${matched}`,
      sql`true`,
    )
    .where(
      and(
        sql`${evidence} #>> '{candidate,target,entityKind}' = ${column("targetKind")}`,
        sql`${evidence} #>> '{candidate,target,entityId}' = ${column("targetCode")}`,
        sql`${evidence} #>> '{candidate,relation}' = ${column("relation")}`,
      ),
    );
  return rows.map((row) => row.id);
}

/** Identity grouping shares the existing family mappings; it does not admit a peer. */
export async function readConnectionAssessmentEdges(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, ConnectionEdge>> {
  if (!ids.length) return new Map();
  const from = alias(entityIdentity, "group_from");
  const to = alias(entityIdentity, "group_to");
  const rows = await getDb(db)
    .select({
      id: assessment.id,
      family: assessment.family,
      scope: sql<string | null>`${assessment.subject}->>'scope'`,
      candidate: sql<unknown>`CASE WHEN ${assessment.family} = ${"recommendation"} THEN ${assessment.evidence}->'candidate' ELSE NULL END`,
      stateEntity: assessmentState.entity,
      field: assessmentState.field,
      fromKind: from.kind,
      fromCode: from.shortcode,
      toKind: to.kind,
      toCode: to.shortcode,
    })
    .from(assessment)
    .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .leftJoin(
      from,
      and(
        eq(from.id, assessmentState.recordId),
        eq(from.kind, assessmentState.entity),
      ),
    )
    .leftJoin(
      to,
      or(
        and(
          eq(assessment.family, "field"),
          eq(to.shortcode, sql`${assessmentState.suggestedValue} #>> '{}'`),
        ),
        and(
          inArray(assessment.family, entityPairAssessmentFamilies),
          eq(
            to.id,
            canonicalPairTargetId(sql`${assessment.subject}->>'otherId'`),
          ),
        ),
      ),
    )
    .where(sql`${assessment.id} = ANY(${uuidArrayParam(ids)})`);
  const edges = new Map<string, ConnectionEdge>();
  for (const row of rows) {
    const relation =
      row.family === "field"
        ? fieldRelations.get(`${row.stateEntity}.${row.field}`)
        : isEntityPairAssessmentFamily(row.family)
          ? pairFamilies[row.family].relation
          : undefined;
    const parsed = connectionEdge.safeParse(
      row.family === "recommendation" && row.scope?.startsWith("connection.")
        ? row.candidate
        : {
            relation,
            source:
              relation === "product-expense"
                ? { entityKind: row.toKind, entityId: row.toCode }
                : { entityKind: row.fromKind, entityId: row.fromCode },
            target:
              relation === "product-expense"
                ? { entityKind: row.fromKind, entityId: row.fromCode }
                : { entityKind: row.toKind, entityId: row.toCode },
          },
    );
    if (parsed.success) edges.set(row.id, parsed.data);
  }
  return edges;
}

/** Keep the original family handle: its review handler owns evidence and writes. */
export async function readExistingConnectionAssessments(
  db: Database,
  sources: readonly EntityRef[],
): Promise<ConnectionProposal[][]> {
  if (!sources.length) return [];
  const from = alias(entityIdentity, "connection_from");
  const to = alias(entityIdentity, "connection_to");
  const keys = sources.map(key);
  // Share discovery and hydration in one statement, including READ COMMITTED callers.
  // Both family reads reference this ID-only CTE, so PostgreSQL materializes it once.
  const matched = getDb(db)
    .$with("matched_existing_assessments")
    .as(existingConnectionAssessmentIds(db, sources));
  // The old text equality admitted only canonical lower-case UUID spellings.
  // Guard the native lookup so malformed or differently spelled history stays unmatched.
  const pairTargetId = canonicalPairTargetId(
    sql`${assessment.subject}->>'otherId'`,
  );
  const rowsFor = (family: "field" | "pair") =>
    getDb(db)
      .select({
        prediction: {
          id: assessment.id,
          family: assessment.family,
          subject: assessment.subject,
          judgment: assessment.judgment,
          producer: assessment.producer,
          fingerprint: assessment.fingerprint,
          evidence:
            sql<unknown>`CASE WHEN ${assessment.family} = ${"product_pair"} THEN ${assessment.evidence} ELSE NULL END`.as(
              "evidence",
            ),
        },
        state: { entity: assessmentState.entity, field: assessmentState.field },
        connectionEvidence: connectionReadEvidenceSql(
          sql`${assessmentState.data}->'connectionEvidence'`,
        ).as("connectionEvidence"),
        sourceKind: sql`${from.kind}`.mapWith(from.kind).as("sourceKind"),
        sourceCode: sql`${from.shortcode}`
          .mapWith(from.shortcode)
          .as("sourceCode"),
        targetKind: sql`${to.kind}`.mapWith(to.kind).as("targetKind"),
        targetCode: sql`${to.shortcode}`.mapWith(to.shortcode).as("targetCode"),
        connectionOrderCreatedAt: sql`${assessment.createdAt}`.as(
          "connectionOrderCreatedAt",
        ),
      })
      .from(assessment)
      .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
      .innerJoin(
        from,
        and(
          eq(from.id, assessmentState.recordId),
          eq(from.kind, assessmentState.entity),
          notDeleted(from),
          sql`${from.mergedIntoId} IS NULL`,
        ),
      )
      .innerJoin(
        to,
        and(
          notDeleted(to),
          sql`${to.mergedIntoId} IS NULL`,
          family === "field"
            ? eq(to.shortcode, sql`${assessmentState.suggestedValue} #>> '{}'`)
            : eq(to.id, pairTargetId),
        ),
      )
      .where(
        and(
          eq(assessment.served, true),
          eq(assessmentState.active, true),
          eq(assessmentState.status, "pending"),
          family === "field"
            ? eq(assessment.family, "field")
            : inArray(assessment.family, entityPairAssessmentFamilies),
          sql`${assessment.id} = ANY(ARRAY(${getDb(db).select({ id: matched.id }).from(matched)}))`,
          sql`(${inArray(sql`${from.kind} || ':' || ${from.shortcode}`, keys)} OR ${inArray(sql`${to.kind} || ':' || ${to.shortcode}`, keys)})`,
          notExists(
            getDb(db)
              .select({ id: feedback.id })
              .from(feedback)
              .where(
                and(
                  eq(feedback.assessmentId, assessment.id),
                  eq(feedback.authority, "member"),
                  inArray(feedback.verdict, ["wrong", "dismissed"]),
                ),
              ),
          ),
          sql`NOT EXISTS (SELECT 1 FROM "AssessmentState" suppressed WHERE suppressed.active AND suppressed.entity=${assessmentState.entity} AND suppressed."recordId"=${assessmentState.recordId} AND suppressed.suppression IS NOT NULL AND suppressed.suppression->>'candidateKey'=CASE WHEN ${assessment.family} IN (${pairFamilyList}) THEN (${assessment.subject}->>'recordId') || '|' || (${assessment.subject}->>'otherId') ELSE '' END)`,
        ),
      );
  const candidates = rowsFor("field")
    .unionAll(rowsFor("pair"))
    .as("existing_connections");
  const rows = await getDb(db)
    .with(matched)
    .select()
    .from(candidates)
    .orderBy(
      sql`${sql.identifier("connectionOrderCreatedAt")}`,
      sql`${sql.identifier("id")}`,
    );
  const proposals = rows.flatMap((row) => {
    const { prediction, state } = row;
    let relation: ConnectionRelation | undefined;
    let integration: ConnectionProposal["integration"];
    let suppression: ConnectionProposal["review"]["suppression"] = null;
    let evidence: ConnectionProposal["evidence"] = {
      reasons: ["Existing domain Assessment"],
      contradictions: [],
      unknowns: ["Review the original Assessment evidence before accepting"],
    };
    if (prediction.family === "field") {
      relation = fieldRelations.get(`${state.entity}.${state.field}`);
      integration = { kind: "field-review", field: state.field };
    } else if (isEntityPairAssessmentFamily(prediction.family)) {
      const family = pairFamilies[prediction.family];
      const judgment = z
        .object({ actionable: z.boolean(), conflict: z.boolean() })
        .safeParse(prediction.judgment);
      if (!judgment.success || !family.current(prediction.producer)) return [];
      relation = family.relation;
      integration = family.integration;
      const subject = z
        .object({ recordId: z.string(), otherId: z.string() })
        .parse(prediction.subject);
      suppression = {
        scope: prediction.family,
        candidateKey: `${subject.recordId}|${subject.otherId}`,
        fingerprint: null,
      };
      const { reason, conflicts, notActionable } = family.explain(
        prediction.evidence,
      );
      evidence = {
        reasons: [reason ?? "Existing domain Assessment"],
        contradictions: judgment.data.conflict
          ? conflicts.length
            ? conflicts
            : [reason ?? "Identity conflict"]
          : [],
        unknowns: judgment.data.actionable ? [] : [notActionable],
      };
    } else {
      // email_link records are operational decisions, never pending suggestions.
      return [];
    }
    if (!relation || !prediction.fingerprint) return [];
    const result = connectionProposal.safeParse({
      relation,
      source:
        relation === "product-expense"
          ? { entityKind: row.targetKind, entityId: row.targetCode }
          : { entityKind: row.sourceKind, entityId: row.sourceCode },
      target:
        relation === "product-expense"
          ? { entityKind: row.sourceKind, entityId: row.sourceCode }
          : { entityKind: row.targetKind, entityId: row.targetCode },
      label: `Review ${relation.replaceAll("-", " ")}`,
      evidence,
      fingerprint: prediction.fingerprint,
      review: {
        assessmentId: prediction.id,
        suppression,
        family: prediction.family,
      },
      integration,
    });
    return result.success ? [result.data] : [];
  });
  const guards = new Map(
    proposals.map((proposal) => [
      proposal,
      connectionReadEvidence.safeParse(
        rows.find((row) => row.prediction.id === proposal.review.assessmentId)
          ?.connectionEvidence,
      ),
    ]),
  );
  const fresh = new Set<ConnectionProposal>();
  const guarded = proposals.flatMap((proposal) => {
    const guard = guards.get(proposal)!;
    if (guard.success) return [{ proposal, candidate: guard.data.candidate }];
    fresh.add(proposal);
    return [];
  });
  await forEachConnectionBasis(db, guarded, async ({ proposal }, basis) => {
    if (await connectionBasisIsCurrent(db, proposal.review.assessmentId, basis))
      fresh.add(proposal);
  });
  return sources.map((source) =>
    proposals
      .filter(
        (p) => key(p.source) === key(source) || key(p.target) === key(source),
      )
      .filter((proposal) => fresh.has(proposal)),
  );
}

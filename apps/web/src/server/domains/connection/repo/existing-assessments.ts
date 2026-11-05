import { suggestionStatus } from "@cubby/schemas/ai";
import {
  type AssessmentProducer,
  type EntityPairAssessmentFamily,
  entityPairAssessmentFamilies,
  assessmentFamily,
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
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  uuidArrayParam,
  sqlEnumConstant,
} from "~/server/db/helpers";
import { outer } from "~/server/db/helpers/related";
import {
  suggestionTable,
  entityIdentity,
} from "~/server/db/schema";
import { currentProductPairPolicy } from "~/server/domains/product/repo/match/product-match-candidate";
import { readStoredProductPair } from "~/server/domains/product/repo/match/product-pair-signals";

import {
  connectionReadEvidence,
  connectionReadEvidenceSql,
  connectionBasisIsCurrent,
  forEachConnectionBasis,
} from "./connection-evidence";
import { memberRejectedSql } from "~/server/generic/assessment/repo/suggestion-decisions";

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
    suggestionTable.active,
    eq(suggestionTable.status, "pending"),
  );
  const idsFor = (families: "all" | "pair", match: SQL) =>
    getDb(db)
      .select({ id: suggestionTable.id })
      .from(suggestionTable)
      .where(
        and(
          suggestionTable.served,
          pendingState,
          inArray(
            suggestionTable.family,
            families === "all"
              ? ["field", ...entityPairAssessmentFamilies]
              : entityPairAssessmentFamilies,
          ),
          match,
        ),
      );
  const fieldIds = getDb(db)
    .select({ id: suggestionTable.id })
    .from(suggestionTable)
    .where(
      and(
        pendingState,
        suggestionTable.served,
        eq(suggestionTable.family, "field"),
        // Exact equality remains authoritative for arbitrary historical text.
        sql`md5(${suggestionTable.suggestedValue} #>> '{}') IN (${codeHashes})
          AND ${suggestionTable.suggestedValue} #>> '{}' IN (${codes})`,
      ),
    );
  const requestedPairs = sql.identifier("existing_pair_requested");
  const pairMembership = sql.identifier("existing_pair_membership");
  const requestedPairId = sql`${requestedPairs}.${sql.identifier("id")}`;
  const pairPointQuery = idsFor(
    "pair",
    sql`${suggestionTable.subject}->>'otherId' IS NOT NULL
      AND md5(${suggestionTable.subject}->>'otherId') = md5(${requestedPairId}::text)
      AND ${suggestionTable.subject}->>'otherId' = ${requestedPairId}::text`,
  );
  // Each endpoint can match many publications. Keep its indexed identity probe
  // parameterized rather than hashing the pair population for a large roster.
  const pairIds = getDb(db)
    .select({
      id: sql<
        typeof suggestionTable.$inferSelect.id
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
    ${inArray(suggestionTable.entity, [...new Set(sources.map((source) => source.entityKind))])}
    AND ${suggestionTable.recordId} IN (${sourceIds})`,
  )
    .union(fieldIds)
    .union(pairIds);
}

/** Source-first barrier shared by selected retrieval and publication grouping. */
function connectionSourcePeers(db: Database, sourceKind: SQL, sourceCode: SQL) {
  const indexed = alias(suggestionTable, "connection_peer_indexed");
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
  const selected = alias(suggestionTable, "selected_connection");
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

/** Exact current edge identities across families, before evidence admission. */
export async function readConnectionEdgeAssessmentIds(
  db: Database,
  edges: readonly ConnectionEdge[],
): Promise<string[]> {
  if (!edges.length) return [];
  const distinct = [
    ...new Map(edges.map((edge) => [connectionEdgeKey(edge), edge])).values(),
  ];
  const fieldRequests = distinct.flatMap((edge) =>
    [...fieldRelations].flatMap(([key, relation]) => {
      if (relation !== edge.relation) return [];
      const owner = relation === "product-expense" ? edge.target : edge.source;
      const suggested =
        relation === "product-expense" ? edge.source : edge.target;
      return [{ owner, suggested, field: key.slice(key.indexOf(".") + 1) }];
    }),
  );
  const pairRequests = distinct.flatMap((edge) =>
    entityPairAssessmentFamilies.flatMap((family) =>
      pairFamilies[family].relation === edge.relation ? [{ edge, family }] : [],
    ),
  );
  // Both endpoint predicates stay inside each point probe. A source or target
  // hub must not materialize unrelated proposals before the edge is checked.
  // Match the grouping reader exactly: recommendation tokens remain raw;
  // fields emit identity shortcodes; pair otherId requires canonical UUID text.
  // includes-deleted: grouping retains tombstoned endpoint identities; canonical
  // admission decides whether their proposals can still be shown.
  const rows = await getDb(db).execute<{ id: string }>(sql`
    WITH requested_edges(relation, "sourceKind", "sourceCode", "targetKind", "targetCode") AS MATERIALIZED (
      VALUES ${sql.join(
        distinct.map(
          (edge) => sql`(${edge.relation}::text,
        ${edge.source.entityKind}::text, ${edge.source.entityId}::text,
        ${edge.target.entityKind}::text, ${edge.target.entityId}::text)`,
        ),
        sql`, `,
      )}
    ), requested_fields(entity, code, field, "targetKind", "targetCode") AS MATERIALIZED (
      ${
        fieldRequests.length
          ? sql`VALUES ${sql.join(
              fieldRequests.map(
                ({ owner, suggested, field }) => sql`(
        ${owner.entityKind}::text, ${owner.entityId}::text, ${field}::text,
        ${suggested.entityKind}::text, ${suggested.entityId}::text)`,
              ),
              sql`, `,
            )}`
          : sql`SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false`
      }
    ), requested_pairs(family, "sourceKind", "sourceCode", "targetKind", "targetCode") AS MATERIALIZED (
      ${
        pairRequests.length
          ? sql`VALUES ${sql.join(
              pairRequests.map(
                ({ edge, family }) => sql`(
        ${family}::text, ${edge.source.entityKind}::text, ${edge.source.entityId}::text,
        ${edge.target.entityKind}::text, ${edge.target.entityId}::text)`,
              ),
              sql`, `,
            )}`
          : sql`SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false`
      }
    )
    SELECT DISTINCT peers.id FROM (
      SELECT matched.id FROM requested_edges r
      CROSS JOIN LATERAL (
        SELECT s.id FROM ${suggestionTable} s
        WHERE s.served AND s.family = ${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.recommendation)}
          AND s.subject->>'scope' LIKE 'connection.%'
          AND s.evidence #>> '{candidate,source,entityKind}' = r."sourceKind"
          AND s.evidence #>> '{candidate,source,entityId}' = r."sourceCode"
          AND s.evidence #>> '{candidate,target,entityKind}' = r."targetKind"
          AND s.evidence #>> '{candidate,target,entityId}' = r."targetCode"
          AND s.evidence #>> '{candidate,relation}' = r.relation
          AND s.active AND s.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}
        OFFSET 0
      ) matched
      UNION ALL
      SELECT matched.id FROM requested_fields r
      JOIN ${entityIdentity} owner ON owner.kind = r.entity AND owner.shortcode = r.code
      JOIN ${entityIdentity} target ON target.kind = r."targetKind" AND target.shortcode = r."targetCode"
      CROSS JOIN LATERAL (
        SELECT s.id FROM ${suggestionTable} s
        WHERE s.entity = r.entity AND s."recordId" = owner.id AND s.field = r.field
          AND s.active AND s.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)} AND s.served AND s.family = ${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.field)}
          AND md5(s."suggestedValue" #>> '{}') = md5(target.shortcode)
          AND s."suggestedValue" #>> '{}' = target.shortcode
        OFFSET 0
      ) matched
      UNION ALL
      SELECT matched.id FROM requested_pairs r
      JOIN ${entityIdentity} owner ON owner.kind = r."sourceKind" AND owner.shortcode = r."sourceCode"
      JOIN ${entityIdentity} target ON target.kind = r."targetKind" AND target.shortcode = r."targetCode"
      CROSS JOIN LATERAL (
        SELECT s.id FROM ${suggestionTable} s
        WHERE s.served AND s.family = r.family AND s.active AND s.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}
          AND s.entity = owner.kind AND s."recordId" = owner.id
          AND s.subject->>'otherId' IS NOT NULL
          AND md5(s.subject->>'otherId') = md5(target.id::text)
          AND s.subject->>'otherId' = target.id::text
        OFFSET 0
      ) matched
    ) peers`);
  return rows.rows.map((row) => row.id);
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
      id: suggestionTable.id,
      family: suggestionTable.family,
      scope: sql<string | null>`${suggestionTable.subject}->>'scope'`,
      candidate: sql<unknown>`CASE WHEN ${suggestionTable.family} = ${"recommendation"} THEN ${suggestionTable.evidence}->'candidate' ELSE NULL END`,
      stateEntity: suggestionTable.entity,
      field: suggestionTable.field,
      fromKind: from.kind,
      fromCode: from.shortcode,
      toKind: to.kind,
      toCode: to.shortcode,
    })
    .from(suggestionTable)
    .leftJoin(
      from,
      and(
        eq(from.id, suggestionTable.recordId),
        eq(from.kind, suggestionTable.entity),
      ),
    )
    .leftJoin(
      to,
      or(
        and(
          eq(suggestionTable.family, "field"),
          eq(to.shortcode, sql`${suggestionTable.suggestedValue} #>> '{}'`),
        ),
        and(
          inArray(suggestionTable.family, entityPairAssessmentFamilies),
          eq(
            to.id,
            canonicalPairTargetId(sql`${suggestionTable.subject}->>'otherId'`),
          ),
        ),
      ),
    )
    .where(sql`${suggestionTable.id} = ANY(${uuidArrayParam(ids)})`);
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
    sql`${suggestionTable.subject}->>'otherId'`,
  );
  const rowsFor = (family: "field" | "pair") =>
    getDb(db)
      .select({
        prediction: {
          id: suggestionTable.id,
          family: suggestionTable.family,
          subject: suggestionTable.subject,
          judgment: suggestionTable.judgment,
          producer: suggestionTable.producer,
          fingerprint: suggestionTable.fingerprint,
          evidence:
            sql<unknown>`CASE WHEN ${suggestionTable.family} = ${"product_pair"} THEN ${suggestionTable.evidence} ELSE NULL END`.as(
              "evidence",
            ),
        },
        state: { entity: suggestionTable.entity, field: suggestionTable.field },
        connectionEvidence: connectionReadEvidenceSql(
          sql`${suggestionTable.data}->'connectionEvidence'`,
        ).as("connectionEvidence"),
        sourceKind: sql`${from.kind}`.mapWith(from.kind).as("sourceKind"),
        sourceCode: sql`${from.shortcode}`
          .mapWith(from.shortcode)
          .as("sourceCode"),
        targetKind: sql`${to.kind}`.mapWith(to.kind).as("targetKind"),
        targetCode: sql`${to.shortcode}`.mapWith(to.shortcode).as("targetCode"),
        connectionOrderCreatedAt: sql`${suggestionTable.createdAt}`.as(
          "connectionOrderCreatedAt",
        ),
      })
      .from(suggestionTable)
      .innerJoin(
        from,
        and(
          eq(from.id, suggestionTable.recordId),
          eq(from.kind, suggestionTable.entity),
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
            ? eq(to.shortcode, sql`${suggestionTable.suggestedValue} #>> '{}'`)
            : eq(to.id, pairTargetId),
        ),
      )
      .where(
        and(
          eq(suggestionTable.served, true),
          eq(suggestionTable.active, true),
          eq(suggestionTable.status, "pending"),
          family === "field"
            ? eq(suggestionTable.family, "field")
            : inArray(suggestionTable.family, entityPairAssessmentFamilies),
          sql`${suggestionTable.id} = ANY(ARRAY(${getDb(db).select({ id: matched.id }).from(matched)}))`,
          sql`(${inArray(sql`${from.kind} || ':' || ${from.shortcode}`, keys)} OR ${inArray(sql`${to.kind} || ':' || ${to.shortcode}`, keys)})`,
          sql`NOT ${memberRejectedSql(sql`${suggestionTable.decisions}`)}`,
          sql`NOT EXISTS (SELECT 1 FROM "Suggestion" suppressed WHERE suppressed.active AND suppressed.entity=${suggestionTable.entity} AND suppressed."recordId"=${suggestionTable.recordId} AND suppressed.suppression IS NOT NULL AND suppressed.suppression->>'candidateKey'=CASE WHEN ${suggestionTable.family} IN (${pairFamilyList}) THEN (${suggestionTable.subject}->>'recordId') || '|' || (${suggestionTable.subject}->>'otherId') ELSE '' END)`,
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

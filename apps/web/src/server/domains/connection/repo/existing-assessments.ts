import {
  type AssessmentProducer,
  type EntityPairAssessmentFamily,
  entityPairAssessmentFamilies,
  isEntityPairAssessmentFamily,
} from "@cubby/schemas/assessment";
import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionProposal,
  type ConnectionProposal,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";
import { PRODUCT_PAIR_NOT_ACTIONABLE } from "@cubby/schemas/recommendations";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
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

/** Keep the original family handle: its review handler owns evidence and writes. */
export async function readExistingConnectionAssessments(
  db: Database,
  sources: readonly EntityRef[],
): Promise<ConnectionProposal[][]> {
  if (!sources.length) return [];
  const from = alias(entityIdentity, "connection_from");
  const to = alias(entityIdentity, "connection_to");
  const keys = sources.map(key);
  const codes = sql.join(
    [...new Set(sources.map((source) => source.entityId))].map(
      (code) => sql`${code}`,
    ),
    sql`, `,
  );
  const sourceIds = sql`SELECT source_entity."id" FROM "Entity" source_entity
    WHERE source_entity."shortcode" IN (${codes})
      AND ${inArray(sql`source_entity."kind" || ':' || source_entity."shortcode"`, keys)}`;
  const rows = await getDb(db)
    .select({
      prediction: {
        id: assessment.id,
        family: assessment.family,
        subject: assessment.subject,
        judgment: assessment.judgment,
        producer: assessment.producer,
        fingerprint: assessment.fingerprint,
        evidence: sql<unknown>`CASE WHEN ${assessment.family} = ${"product_pair"} THEN ${assessment.evidence} ELSE NULL END`,
      },
      state: { entity: assessmentState.entity, field: assessmentState.field },
      connectionEvidence: connectionReadEvidenceSql(
        sql`${assessmentState.data}->'connectionEvidence'`,
      ),
      sourceKind: from.kind,
      sourceCode: from.shortcode,
      targetKind: to.kind,
      targetCode: to.shortcode,
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
        sql`CASE ${assessment.family}
      WHEN ${"field"} THEN ${to.shortcode}=(${assessmentState.suggestedValue} #>> '{}')
      ELSE ${assessment.family} IN (${pairFamilyList}) AND ${to.id}::text=${assessment.subject}->>'otherId' END`,
      ),
    )
    .where(
      and(
        eq(assessment.served, true),
        eq(assessmentState.active, true),
        eq(assessmentState.status, "pending"),
        inArray(assessment.family, ["field", ...entityPairAssessmentFamilies]),
        // Implied by the endpoint keys below, but sargable on the Assessment
        // side: without it every pending state joined Entity before the keys
        // could reject it.
        sql`(${assessmentState.recordId} IN (${sourceIds})
          OR (${assessment.family} = ${"field"} AND ${assessmentState.suggestedValue} #>> '{}' IN (${codes}))
          OR (${assessment.family} IN (${pairFamilyList}) AND ${assessment.subject}->>'otherId' IN (SELECT source_id::text FROM (${sourceIds}) source_ids(source_id))))`,
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
    )
    .orderBy(assessment.createdAt, assessment.id);
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

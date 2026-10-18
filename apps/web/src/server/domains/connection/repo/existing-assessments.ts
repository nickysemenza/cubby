import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionAssessmentEvidence,
  connectionProposal,
  type ConnectionProposal,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";
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
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";

import { captureConnectionBasis } from "./connection-evidence";

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
  const rows = await getDb(db)
    .select({
      prediction: assessment,
      state: assessmentState,
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
      WHEN ${"product_pair"} THEN ${to.id}::text=${assessment.subject}->>'otherId'
      ELSE false END`,
      ),
    )
    .where(
      and(
        eq(assessment.served, true),
        eq(assessmentState.active, true),
        eq(assessmentState.status, "pending"),
        inArray(assessment.family, ["field", "product_pair"]),
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
        sql`NOT EXISTS (SELECT 1 FROM "AssessmentState" suppressed WHERE suppressed.active AND suppressed.entity=${assessmentState.entity} AND suppressed."recordId"=${assessmentState.recordId} AND suppressed.suppression IS NOT NULL AND suppressed.suppression->>'candidateKey'=CASE ${assessment.family} WHEN ${"product_pair"} THEN (${assessment.subject}->>'recordId') || '|' || (${assessment.subject}->>'otherId') ELSE '' END)`,
      ),
    )
    .orderBy(assessment.createdAt, assessment.id);
  const proposals = rows.flatMap((row) => {
    const { prediction, state } = row;
    let relation: ConnectionRelation | undefined;
    let integration: ConnectionProposal["integration"];
    let suppression: ConnectionProposal["review"]["suppression"] = null;
    if (prediction.family === "field") {
      relation = fieldRelations.get(`${state.entity}.${state.field}`);
      integration = { kind: "field-review", field: state.field };
    } else if (prediction.family === "product_pair") {
      const judgment = z
        .object({ actionable: z.boolean(), conflict: z.boolean() })
        .safeParse(prediction.judgment);
      if (
        !judgment.success ||
        !judgment.data.actionable ||
        judgment.data.conflict ||
        !currentProductPairPolicy(prediction.producer)
      )
        return [];
      relation = "product-identity";
      integration = { kind: "product-pair-review" };

      const subject = z
        .object({ recordId: z.string(), otherId: z.string() })
        .parse(prediction.subject);
      suppression = {
        scope: "product_pair",
        candidateKey: `${subject.recordId}|${subject.otherId}`,
        fingerprint: null,
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
      evidence: {
        reasons: ["Existing domain Assessment"],
        contradictions: [],
        unknowns: ["Review the original Assessment evidence before accepting"],
      },
      fingerprint: prediction.fingerprint,
      review: { assessmentId: prediction.id, suppression },
      integration,
    });
    return result.success ? [result.data] : [];
  });
  const fresh: ConnectionProposal[] = [];
  for (const proposal of proposals) {
    const row = rows.find(
      (row) => row.prediction.id === proposal.review.assessmentId,
    );
    const guard = z
      .object({ connectionEvidence: connectionAssessmentEvidence })
      .safeParse(row?.state.data);
    if (guard.success) {
      const basis = await captureConnectionBasis(
        db,
        guard.data.connectionEvidence.candidate,
      );
      if (
        canonicalJson(basis) !==
        canonicalJson(guard.data.connectionEvidence.basis)
      )
        continue;
    }
    fresh.push(proposal);
  }
  return sources.map((source) =>
    fresh.filter(
      (p) => key(p.source) === key(source) || key(p.target) === key(source),
    ),
  );
}

import { confidence } from "@cubby/schemas/ai";
import { aiProvenance } from "@cubby/schemas/ai-evaluation";
import { assessmentProducer } from "@cubby/schemas/assessment";
import { productId } from "@cubby/schemas/identifiers";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState } from "~/server/db/schema";

const variantDimension = z.enum(["color", "size", "pack"]);
export const productIdentitySide = z.object({
  id: productId,
  model: z.string().nullable(),
});

// Decoder for retained Assessment JSON only; these receipts confer no current authority.
const variantLiteral = z.object({
  productId,
  sourceId: z.uuid(),
  field: z.literal("name"),
  valueFingerprint: z.string(),
  quote: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  value: z.string().min(1),
  binding: z.enum(["unambiguous", "selected_variant"]),
  selectedVariant: z.string().nullable(),
});
const variantDecisionReceipt = z.object({
  request: z.object({
    subject: z.string(),
    rules: z.string(),
    choices: z.array(z.string()),
    allowNone: z.boolean(),
  }),
  result: z
    .object({
      selectedIndex: z.number().int().nonnegative().nullable(),
      confidence,
      probability: z.number().min(0).max(1),
    })
    .catchall(z.json()),
  inputFingerprint: z.string(),
});
export const groundedVariantEvidence = z.object({
  producer: assessmentProducer,
  inputFingerprint: z.string(),
  priorConflictIds: z.array(z.uuid()),
  dependencies: aiProvenance.shape.dependencies,
  dimensions: z
    .array(
      z.object({
        dimension: variantDimension,
        first: variantLiteral.nullable(),
        second: variantLiteral.nullable(),
        relation: z.enum(["same", "different", "unknown"]),
        decisions: z.array(variantDecisionReceipt),
      }),
    )
    .length(3),
});
export const variantVerification = z.enum([
  "unknown",
  "current",
  "pending_verification",
]);

/** Explicit review may supersede an old comparison; unchanged inputs cannot bypass it. */
export async function historicalConflictInputsChanged(
  db: Database,
  conflictIds: readonly string[],
  currentFingerprint: string,
) {
  if (conflictIds.length === 0) return true;
  const prior = await getDb(db)
    .select({ fingerprint: assessment.fingerprint })
    .from(assessment)
    .where(
      and(
        eq(assessment.family, "product_pair"),
        inArray(assessment.id, [...conflictIds]),
      ),
    );
  return (
    prior.length === new Set(conflictIds).size &&
    prior.every((row) => row.fingerprint !== currentFingerprint)
  );
}

/** Historical conflict is a guard, not a claim that stale source evidence is current. */
export async function readVariantVerification(
  db: Database,
  sides: readonly [
    z.infer<typeof productIdentitySide>,
    z.infer<typeof productIdentitySide>,
  ],
) {
  const history = await getDb(db)
    .select({ id: assessment.id, evidence: assessment.evidence })
    .from(assessment)
    .leftJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .where(
      and(
        eq(assessment.family, "product_pair"),
        eq(assessment.served, true),
        or(
          and(
            sql`${assessment.subject}->>'recordId' = ${sides[0].id}`,
            sql`${assessment.subject}->>'otherId' = ${sides[1].id}`,
          ),
          and(
            eq(assessmentState.recordId, sides[0].id),
            sql`${assessmentState.data}->>'otherId' = ${sides[1].id}`,
          ),
        ),
      ),
    )
    .orderBy(desc(assessment.createdAt), desc(assessment.id));
  const lineage = z
    .object({
      signals: z
        .object({ conflictLineage: z.array(z.uuid()).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough();
  const ancestorIds = [
    ...new Set(
      history.flatMap(
        (row) =>
          lineage.safeParse(row.evidence).data?.signals?.conflictLineage ?? [],
      ),
    ),
  ].filter((id) => !history.some((row) => row.id === id));
  if (ancestorIds.length)
    history.push(
      ...(await getDb(db)
        .select({ id: assessment.id, evidence: assessment.evidence })
        .from(assessment)
        .where(
          and(
            eq(assessment.family, "product_pair"),
            inArray(assessment.id, ancestorIds),
          ),
        )),
    );
  const historicalEvidence = z
    .object({
      conflict: z.boolean().optional(),
      signals: z
        .object({ variantEvidence: z.json().optional() })
        .passthrough()
        .optional(),
    })
    .passthrough();
  const previous = history.flatMap((row) => {
    const parsed = historicalEvidence.safeParse(row.evidence);
    return parsed.success ? [{ ...parsed.data, id: row.id }] : [];
  });
  const priorConflictIds = previous
    .filter(
      (row) =>
        row.conflict ||
        groundedVariantEvidence
          .safeParse(row.signals?.variantEvidence)
          .data?.dimensions.some(
            (dimension) => dimension.relation === "different",
          ),
    )
    .map((row) => row.id)
    .sort();
  const conflict =
    sides[0].model !== null &&
    sides[1].model !== null &&
    sides[0].model !== sides[1].model;
  return {
    conflict,
    priorConflictIds,
    verification: variantVerification.parse(
      priorConflictIds.length ? "pending_verification" : "unknown",
    ),
    variantEvidence: null,
  };
}

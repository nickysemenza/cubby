import { confidence } from "@cubby/schemas/ai";
import { aiProvenance } from "@cubby/schemas/ai-evaluation";
import { assessmentProducer } from "@cubby/schemas/assessment";
import { productId } from "@cubby/schemas/identifiers";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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

type IdentitySides = readonly [
  z.infer<typeof productIdentitySide>,
  z.infer<typeof productIdentitySide>,
];
export type ProductVariantVerification = {
  conflict: boolean;
  priorConflictIds: string[];
  verification: z.infer<typeof variantVerification>;
  variantEvidence: null;
};
const pairKey = (sides: IdentitySides) =>
  [sides[0].id, sides[1].id].sort().join("|");

/** Historical conflict is a guard, not a claim that stale source evidence is current.
 * Served history is matched by immutable subject or its repointed projection;
 * referenced conflict ancestors are loaded once, including unserved ancestors.
 */
export async function readVariantVerifications(
  db: Database,
  pairs: readonly IdentitySides[],
): Promise<Map<string, ProductVariantVerification>> {
  const unique = new Map(pairs.map((sides) => [pairKey(sides), sides]));
  const result = new Map<string, ProductVariantVerification>();
  if (!unique.size) return result;
  const keys = [...unique.keys()];
  const subjectKey = sql<string>`least(${assessment.subject}->>'recordId', ${assessment.subject}->>'otherId') || '|' || greatest(${assessment.subject}->>'recordId', ${assessment.subject}->>'otherId')`;
  const stateKey = sql<string>`least(${assessmentState.recordId}::text, ${assessmentState.data}->>'otherId') || '|' || greatest(${assessmentState.recordId}::text, ${assessmentState.data}->>'otherId')`;
  const historyQuery = getDb(db)
    .select({
      id: assessment.id,
      evidence: assessment.evidence,
      subjectKey: subjectKey.as("subjectKey"),
      stateKey: stateKey.as("stateKey"),
    })
    .from(assessment)
    .leftJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .where(
      and(
        eq(assessment.family, "product_pair"),
        eq(assessment.served, true),
        sql`(${inArray(subjectKey, keys)} OR ${inArray(stateKey, keys)})`,
      ),
    )
    .orderBy(desc(assessment.createdAt), desc(assessment.id));
  const allRows = z
    .object({
      rows: z.array(
        z.object({
          id: z.string(),
          evidence: z.json(),
          subjectKey: z.string().nullable(),
          stateKey: z.string().nullable(),
        }),
      ),
    })
    .parse(
      await getDb(db).execute(sql`
    WITH history AS MATERIALIZED (${historyQuery}), ancestors AS (
      SELECT DISTINCT jsonb_array_elements_text(CASE WHEN jsonb_typeof(evidence->'signals'->'conflictLineage') = 'array' THEN evidence->'signals'->'conflictLineage' ELSE '[]'::jsonb END) AS id FROM history
    ) SELECT * FROM history
    UNION ALL SELECT a.id, a.evidence, NULL::text AS "subjectKey", NULL::text AS "stateKey" FROM "Assessment" a JOIN ancestors p ON a.id::text = p.id
    WHERE a.family = ${"product_pair"} AND NOT EXISTS (SELECT 1 FROM history h WHERE h.id = a.id)
  `),
    ).rows;
  const history = allRows.filter(
    (row) => row.subjectKey !== null || row.stateKey !== null,
  );
  const lineage = z
    .object({
      signals: z
        .object({ conflictLineage: z.array(z.uuid()).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough();
  const lineageOf = (evidence: unknown) =>
    lineage.safeParse(evidence).data?.signals?.conflictLineage ?? [];
  const rowsById = new Map(allRows.map((row) => [row.id, row]));
  const byKey = new Map<string, typeof history>();
  for (const row of history) {
    for (const key of new Set([row.subjectKey, row.stateKey])) {
      if (key === null || !unique.has(key)) continue;
      const rows = byKey.get(key) ?? [];
      rows.push(row);
      byKey.set(key, rows);
    }
  }
  for (const [key, sides] of unique) {
    const direct = byKey.get(key) ?? [];
    const ids = new Set([
      ...direct.map((row) => row.id),
      ...direct.flatMap((row) => lineageOf(row.evidence)),
    ]);
    const rows = [...ids].flatMap((id) => {
      const row = rowsById.get(id);
      return row ? [row] : [];
    });
    result.set(key, variantVerificationFromHistory(sides, rows));
  }
  return result;
}
function variantVerificationFromHistory(
  sides: IdentitySides,
  history: readonly { id: string; evidence: unknown }[],
): ProductVariantVerification {
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

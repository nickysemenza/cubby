import { confidence } from "@cubby/schemas/ai";
import { aiProvenance } from "@cubby/schemas/ai-evaluation";
import { assessmentProducer } from "@cubby/schemas/assessment";
import { productId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { PRODUCT_IDENTITY_FEATURE } from "~/server/ai/features";
import type { Database } from "~/server/db";
import { assessment, assessmentState } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { canonicalJson } from "~/server/repo/entity-source";

export const variantDimension = z.enum(["color", "size", "pack"]);
export const variantSourceSide = z.object({
  id: productId,
  name: z.string(),
  verifiedModel: z.string().nullable().default(null),
  sources: z.array(
    z.object({
      id: z.uuid(),
      field: z.string().nullable(),
      valueFingerprint: z.string().nullable(),
      quote: z.string().nullable(),
      selectedVariant: z.string().nullable(),
    }),
  ),
});
export const variantLiteral = z.object({
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
export const variantDecisionReceipt = z.object({
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

/** Offsets are UTF-16 string offsets, validated against exact retained quote bytes. */
async function validVariantLiteral(
  literal: z.infer<typeof variantLiteral>,
  side: z.infer<typeof variantSourceSide>,
) {
  const source = side.sources.find((row) => row.id === literal.sourceId);
  return (
    literal.productId === side.id &&
    source?.field === "name" &&
    source.valueFingerprint === literal.valueFingerprint &&
    source.valueFingerprint === (await sha256Hex(canonicalJson(side.name))) &&
    source.quote === literal.quote &&
    source.selectedVariant === literal.selectedVariant &&
    literal.end <= literal.quote.length &&
    literal.start < literal.end &&
    literal.quote.slice(literal.start, literal.end) === literal.value &&
    (literal.binding !== "selected_variant" ||
      source.selectedVariant?.includes(literal.value) === true)
  );
}

const jsonValue = (value: string) => {
  try {
    return z.json().parse(JSON.parse(value));
  } catch {
    return null;
  }
};

async function validVariantEvidence(
  raw: z.infer<ReturnType<typeof z.json>> | undefined,
  sides: readonly [
    z.infer<typeof variantSourceSide>,
    z.infer<typeof variantSourceSide>,
  ],
  revision: string,
) {
  const parsed = groundedVariantEvidence.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.inputFingerprint !==
      (await sha256Hex(canonicalJson([...sides]))) ||
    parsed.data.producer.kind !== "model" ||
    !parsed.data.producer.model ||
    parsed.data.producer.revision !== revision ||
    new Set(parsed.data.dimensions.map((row) => row.dimension)).size !== 3
  )
    return null;
  for (const row of parsed.data.dimensions) {
    if (
      (row.first && !(await validVariantLiteral(row.first, sides[0]))) ||
      (row.second && !(await validVariantLiteral(row.second, sides[1])))
    )
      return null;
    if (row.relation === "unknown") continue;
    if (!row.first || !row.second || row.decisions.length !== 3) return null;
    for (const [index, literal] of [row.first, row.second].entries()) {
      const receipt = row.decisions[index]!;
      const selected =
        receipt.result.selectedIndex === null
          ? null
          : variantLiteral.safeParse(
              jsonValue(
                receipt.request.choices[receipt.result.selectedIndex] ?? "null",
              ),
            ).data;
      const subject = z
        .object({
          phase: z.literal("variant_literal"),
          dimension: variantDimension,
          productId,
        })
        .safeParse(jsonValue(receipt.request.subject));
      if (
        !subject.success ||
        subject.data.dimension !== row.dimension ||
        subject.data.productId !== literal.productId ||
        receipt.result.confidence !== "high" ||
        receipt.result.probability < 0.85 ||
        receipt.result.selectedIndex === null ||
        !selected ||
        canonicalJson(selected) !== canonicalJson(literal) ||
        receipt.inputFingerprint !==
          (await sha256Hex(canonicalJson(receipt.request)))
      )
        return null;
    }
    const relation = row.decisions[2]!;
    const subject = z
      .object({
        phase: z.literal("variant_relation"),
        dimension: variantDimension,
        first: variantLiteral,
        second: variantLiteral,
      })
      .safeParse(jsonValue(relation.request.subject));
    if (
      !subject.success ||
      subject.data.dimension !== row.dimension ||
      canonicalJson(subject.data.first) !== canonicalJson(row.first) ||
      canonicalJson(subject.data.second) !== canonicalJson(row.second) ||
      relation.result.confidence !== "high" ||
      relation.result.probability < 0.85 ||
      relation.result.selectedIndex === null ||
      relation.request.choices[relation.result.selectedIndex] !==
        row.relation ||
      relation.inputFingerprint !==
        (await sha256Hex(canonicalJson(relation.request)))
    )
      return null;
  }
  return parsed.data;
}

/** Historical conflict is a guard, not a claim that stale source evidence is current. */
export async function readVariantVerification(
  db: Database,
  sides: readonly [
    z.infer<typeof variantSourceSide>,
    z.infer<typeof variantSourceSide>,
  ],
  revision: string,
  proposed?: z.infer<ReturnType<typeof z.json>>,
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
  const { producingAiManifest } = await import("~/server/repo/ai-refresh");
  const { dependenciesCurrent } = await import("~/server/ai/refresh-policy");
  const manifest = await producingAiManifest(db);
  const currentEvidence = async (
    raw: z.infer<ReturnType<typeof z.json>> | undefined,
  ) => {
    const proof = await validVariantEvidence(raw, sides, revision);
    if (
      !proof ||
      !proof.dependencies.some(
        (stamp) => stamp.feature === PRODUCT_IDENTITY_FEATURE.feature,
      ) ||
      !dependenciesCurrent(
        {
          dependencies: proof.dependencies,
          inputFingerprint: "",
          optionFingerprint: "",
          model: proof.producer.model,
        },
        manifest,
      )
    )
      return null;
    if (
      !proof.dimensions.some((row) => row.relation === "different") &&
      priorConflictIds.some((id) => !proof.priorConflictIds.includes(id))
    )
      return null;
    return proof;
  };
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
  const oldDimensions = new Set<z.infer<typeof variantDimension>>();
  let unknownPriorConflict = false;
  let priorModelConflict = false;
  for (const row of previous) {
    const grounded = groundedVariantEvidence.safeParse(
      row.signals?.variantEvidence,
    );
    let knownVariantConflict = false;
    if (grounded.success)
      for (const dimension of grounded.data.dimensions) {
        if (dimension.relation === "different") {
          oldDimensions.add(dimension.dimension);
          knownVariantConflict = true;
        }
      }
    const models = z
      .object({
        snapshots: z.tuple([
          z.object({ verifiedModel: z.string().nullable() }),
          z.object({ verifiedModel: z.string().nullable() }),
        ]),
      })
      .safeParse(row.signals);
    const knownModelConflict =
      models.success &&
      models.data.snapshots[0].verifiedModel !== null &&
      models.data.snapshots[1].verifiedModel !== null &&
      models.data.snapshots[0].verifiedModel !==
        models.data.snapshots[1].verifiedModel;
    if (row.conflict && knownModelConflict) priorModelConflict = true;
    if (row.conflict && !knownVariantConflict && !knownModelConflict)
      unknownPriorConflict = true;
  }
  let current = await currentEvidence(proposed);
  if (!current)
    for (const row of previous) {
      current = await currentEvidence(row.signals?.variantEvidence);
      if (current) break;
    }
  const modelValuesAgree =
    sides[0].verifiedModel !== null &&
    sides[1].verifiedModel !== null &&
    sides[0].verifiedModel === sides[1].verifiedModel;
  const modelConflict =
    sides[0].verifiedModel !== null &&
    sides[1].verifiedModel !== null &&
    sides[0].verifiedModel !== sides[1].verifiedModel;
  const conflict =
    modelConflict ||
    (current?.dimensions.some((row) => row.relation === "different") ?? false);
  const required = unknownPriorConflict
    ? variantDimension.options
    : [...oldDimensions];
  const pending =
    !conflict &&
    ((priorModelConflict && !modelValuesAgree) ||
      required.some(
        (dimension) =>
          !current?.dimensions.some(
            (row) => row.dimension === dimension && row.relation === "same",
          ),
      ));
  return {
    conflict,
    priorConflictIds,
    verification: variantVerification.parse(
      pending ? "pending_verification" : current ? "current" : "unknown",
    ),
    variantEvidence: current,
  };
}

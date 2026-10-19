import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";
import { z } from "zod";

import { unknownProductVariantComparison } from "~/server/domains/product/repo/product-variant-comparison";
import { groundedVariantEvidence } from "~/server/domains/product/repo/product-variant-evidence";

const snapshotModel = z
  .object({ id: z.string().optional(), verifiedModel: z.string().nullable() })
  .passthrough();
const storedPair = z
  .object({
    evidence: z.string().nullable().optional(),
    signals: z
      .object({
        variantEvidence: z.json().nullish(),
        snapshots: z.json().optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const DIMENSION_LABEL = { color: "Color", size: "Size", pack: "Pack" } as const;

/**
 * Reads the detector's stored projection of one `product_pair`
 * (`Assessment.evidence` / `AssessmentState.data`). Reasons quote the stored
 * values verbatim; `firstId` orders each reason's sides for the caller.
 */
export function readStoredProductPair(data: unknown, firstId?: string) {
  const parsed = storedPair.safeParse(data).data;
  const grounded = groundedVariantEvidence.safeParse(
    parsed?.signals?.variantEvidence,
  );
  const snapshots = z
    .tuple([snapshotModel, snapshotModel])
    .safeParse(parsed?.signals?.snapshots);
  const ordered = <T>(pair: readonly [T, T], leadId: string | undefined) =>
    firstId && leadId && leadId !== firstId ? [pair[1], pair[0]] : pair;
  const conflictReasons: string[] = [];
  if (snapshots.success) {
    const [a, b] = snapshots.data;
    if (
      a.verifiedModel !== null &&
      b.verifiedModel !== null &&
      a.verifiedModel !== b.verifiedModel
    ) {
      const [first, second] = ordered([a.verifiedModel, b.verifiedModel], a.id);
      conflictReasons.push(`Verified model: "${first}" vs "${second}"`);
    }
  }
  for (const row of grounded.data?.dimensions ?? []) {
    if (row.relation !== "different") continue;
    const [first, second] = ordered(
      [row.first?.value ?? "unbound", row.second?.value ?? "unbound"],
      row.first?.productId,
    );
    conflictReasons.push(
      `${DIMENSION_LABEL[row.dimension]}: "${first}" vs "${second}"`,
    );
  }
  return {
    evidence: parsed?.evidence ?? null,
    variantEvidence: grounded.success ? grounded.data : null,
    conflictReasons,
  };
}

/** Unknown only when the detector stored no grounded variant evidence. */
export function storedVariantComparison(
  variantEvidence: ReturnType<typeof readStoredProductPair>["variantEvidence"],
  firstTitle: string,
  secondTitle: string,
): ProductVariantComparison {
  const unknown = unknownProductVariantComparison(firstTitle, secondTitle);
  if (!variantEvidence) return unknown;
  const relation = (dimension: "color" | "size") => ({
    relation:
      variantEvidence.dimensions.find((row) => row.dimension === dimension)
        ?.relation ?? ("unknown" as const),
  });
  return { ...unknown, color: relation("color"), size: relation("size") };
}

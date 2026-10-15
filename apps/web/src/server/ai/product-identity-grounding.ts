import type { AiProvenance } from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import {
  runDecisionChoices,
  DECISION_MAX_CANDIDATES,
  type DecisionPort,
  type DecisionChoiceResult,
} from "~/server/ai/decision-model";
import { PRODUCT_IDENTITY_FEATURE } from "~/server/ai/repo/feature-identity";
import type { Database } from "~/server/db";
import {
  groundedVariantEvidence,
  variantDecisionReceipt,
  variantDimension,
  variantLiteral,
  variantSourceSide,
} from "~/server/domains/product/repo/product-variant-evidence";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";

/** Structural span candidates carry no color, garment, size or pack vocabulary. */
async function literalCandidates(side: z.infer<typeof variantSourceSide>) {
  const fingerprint = await sha256Hex(canonicalJson(side.name));
  const candidates: z.infer<typeof variantLiteral>[] = [];
  for (const source of side.sources) {
    if (
      source.field !== "name" ||
      source.valueFingerprint !== fingerprint ||
      !source.quote
    )
      continue;
    const tokens = [...source.quote.matchAll(/[^\s,;|:()[\]{}]+/gu)];
    for (let first = 0; first < tokens.length; first++)
      for (
        let count = 1;
        count <= 6 && first + count <= tokens.length;
        count++
      ) {
        const start = tokens[first]!.index,
          last = tokens[first + count - 1]!,
          end = last.index + last[0].length;
        const value = source.quote.slice(start, end);
        candidates.push({
          productId: side.id,
          sourceId: source.id,
          field: "name",
          valueFingerprint: fingerprint,
          quote: source.quote,
          start,
          end,
          value,
          selectedVariant: source.selectedVariant,
          binding: source.selectedVariant?.includes(value)
            ? "selected_variant"
            : "unambiguous",
        });
        if (candidates.length > DECISION_MAX_CANDIDATES) return [];
      }
  }
  return candidates;
}

async function decisionReceipt(
  request: z.infer<typeof variantDecisionReceipt>["request"],
  result: DecisionChoiceResult,
) {
  return variantDecisionReceipt.parse({
    request,
    result,
    inputFingerprint: await sha256Hex(canonicalJson(request)),
  });
}

/** Runs only inside the existing durable Product identity evaluation. */
export async function groundProductIdentityVariants(input: {
  db: Database;
  runId: RunId;
  evaluationId?: string;
  model: SupportedDecisionModel;
  first: z.infer<typeof variantSourceSide>;
  second: z.infer<typeof variantSourceSide>;
  priorConflictIds: string[];
  decisionPort?: DecisionPort;
  provenance?: AiProvenance;
}) {
  const { producingAiManifest } = await import("~/server/ai/repo/ai-refresh");
  const { dependencyStamps } = await import("~/server/ai/repo/refresh-policy");
  const sides = [
    variantSourceSide.parse(input.first),
    variantSourceSide.parse(input.second),
  ] as const;
  const rosters = await Promise.all(sides.map(literalCandidates));
  if (rosters.some((rows) => rows.length === 0)) return null;
  const literalQuestions = variantDimension.options.flatMap((dimension) =>
    sides.map((side, index) => ({
      prompt: {
        subject: JSON.stringify({
          phase: "variant_literal",
          dimension,
          productId: side.id,
          name: side.name,
        }),
        rules: `Select only an explicit literal ${dimension} value for this exact current Product, grounded in the supplied retained source quote. A catalogue containing multiple possible ${dimension} values is ambiguous: use none unless selectedVariant explicitly binds the chosen literal. Never infer a default pack, interpret model/style numbers as size, choose a brand as color, or invent normalized values. Use none for uncertainty or absent facts. Candidate spans are structural possibilities, not verified attributes.`,
        choices: rosters[index]!.map((row) => JSON.stringify(row)),
        allowNone: true,
      },
    })),
  );
  const literalUsage = {
    db: input.db,
    runId: input.runId,
    operation: "product-identity.variant-literals",
  };
  const literalResults = await runDecisionChoices(
    literalQuestions.map(({ prompt }) => ({
      ...prompt,
      feature: PRODUCT_IDENTITY_FEATURE,
      decisionModel: input.model,
      port: input.decisionPort,
      usage: literalUsage,
    })),
  );
  const dimensions: z.infer<typeof groundedVariantEvidence>["dimensions"] = [];
  for (const [
    dimensionIndex,
    dimension,
  ] of variantDimension.options.entries()) {
    const selected = sides.map((_, sideIndex) => {
      const result = literalResults[dimensionIndex * sides.length + sideIndex]!;
      return result.confidence === "high" &&
        result.probability >= 0.85 &&
        result.selectedIndex !== null
        ? (rosters[sideIndex]![result.selectedIndex] ?? null)
        : null;
    });
    const decisions = await Promise.all(
      sides.map((_, sideIndex) => {
        const index = dimensionIndex * sides.length + sideIndex;
        return decisionReceipt(
          literalQuestions[index]!.prompt,
          literalResults[index]!,
        );
      }),
    );
    dimensions.push({
      dimension,
      first: selected[0] ?? null,
      second: selected[1] ?? null,
      relation: "unknown",
      decisions,
    });
  }
  const relationQuestions = dimensions.flatMap(
    ({ dimension, first, second }, index) =>
      first && second
        ? [
            {
              index,
              prompt: {
                subject: JSON.stringify({
                  phase: "variant_relation",
                  dimension,
                  first,
                  second,
                }),
                rules: `Compare only these two source-grounded literal ${dimension} values in their original quotes for the selected current Products. Choose unknown when either meaning or selected-variant binding is ambiguous. This is a source-grounded semantic judgment, not independent proof of the source's truth.`,
                choices: ["same", "different", "unknown"],
                allowNone: true,
              },
            },
          ]
        : [],
  );
  const relationUsage = {
    db: input.db,
    runId: input.runId,
    operation: "product-identity.variant-relations",
  };
  const relationResults = await runDecisionChoices(
    relationQuestions.map(({ prompt }) => ({
      ...prompt,
      feature: PRODUCT_IDENTITY_FEATURE,
      decisionModel: input.model,
      port: input.decisionPort,
      usage: relationUsage,
    })),
  );
  for (const [offset, { index, prompt }] of relationQuestions.entries()) {
    const decision = relationResults[offset]!;
    const dimension = dimensions[index]!;
    dimension.decisions.push(await decisionReceipt(prompt, decision));
    if (decision.confidence === "high" && decision.probability >= 0.85)
      dimension.relation =
        groundedVariantEvidence.shape.dimensions.element.shape.relation.parse(
          decision.selectedIndex === null
            ? "unknown"
            : prompt.choices[decision.selectedIndex],
        );
  }
  return groundedVariantEvidence.parse({
    inputFingerprint: await sha256Hex(canonicalJson([...sides])),
    priorConflictIds: input.priorConflictIds,
    producer: {
      kind: "model",
      model: input.model,
      revision: PRODUCT_IDENTITY_FEATURE.promptVersion,
      runId: input.runId,
      evaluationId: input.evaluationId ?? null,
    },
    dependencies:
      input.provenance?.dependencies ??
      dependencyStamps(await producingAiManifest(input.db), [
        PRODUCT_IDENTITY_FEATURE.feature,
      ]),
    dimensions,
  });
}

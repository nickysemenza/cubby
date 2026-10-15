import type { AiProvenance } from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import {
  runDecisionChoice,
  DECISION_MAX_CANDIDATES,
  type DecisionPort,
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
  const dimensions: z.infer<typeof groundedVariantEvidence>["dimensions"] = [];
  for (const dimension of variantDimension.options) {
    const selected: (z.infer<typeof variantLiteral> | null)[] = [];
    const decisions: z.infer<
      typeof groundedVariantEvidence
    >["dimensions"][number]["decisions"] = [];
    for (const [index, side] of sides.entries()) {
      const roster = rosters[index]!;
      const prompt = {
        subject: JSON.stringify({
          phase: "variant_literal",
          dimension,
          productId: side.id,
          name: side.name,
        }),
        rules: `Select only an explicit literal ${dimension} value for this exact current Product, grounded in the supplied retained source quote. A catalogue containing multiple possible ${dimension} values is ambiguous: use none unless selectedVariant explicitly binds the chosen literal. Never infer a default pack, interpret model/style numbers as size, choose a brand as color, or invent normalized values. Use none for uncertainty or absent facts. Candidate spans are structural possibilities, not verified attributes.`,
        choices: roster.map((row) => JSON.stringify(row)),
        allowNone: true,
      };
      const decision = await runDecisionChoice({
        ...prompt,
        feature: PRODUCT_IDENTITY_FEATURE,
        decisionModel: input.model,
        port: input.decisionPort,
        usage: {
          db: input.db,
          runId: input.runId,
          operation: `product-identity.${dimension}.literal`,
        },
      });
      decisions.push(
        variantDecisionReceipt.parse({
          request: prompt,
          result: decision,
          inputFingerprint: await sha256Hex(canonicalJson(prompt)),
        }),
      );
      selected.push(
        decision.confidence === "high" &&
          decision.probability >= 0.85 &&
          decision.selectedIndex !== null
          ? (roster[decision.selectedIndex] ?? null)
          : null,
      );
    }
    let relation: "same" | "different" | "unknown" = "unknown";
    if (selected[0] && selected[1]) {
      const prompt = {
        subject: JSON.stringify({
          phase: "variant_relation",
          dimension,
          first: selected[0],
          second: selected[1],
        }),
        rules: `Compare only these two source-grounded literal ${dimension} values in their original quotes for the selected current Products. Choose unknown when either meaning or selected-variant binding is ambiguous. This is a source-grounded semantic judgment, not independent proof of the source's truth.`,
        choices: ["same", "different", "unknown"],
        allowNone: true,
      };
      const decision = await runDecisionChoice({
        ...prompt,
        feature: PRODUCT_IDENTITY_FEATURE,
        decisionModel: input.model,
        port: input.decisionPort,
        usage: {
          db: input.db,
          runId: input.runId,
          operation: `product-identity.${dimension}.relation`,
        },
      });
      decisions.push(
        variantDecisionReceipt.parse({
          request: prompt,
          result: decision,
          inputFingerprint: await sha256Hex(canonicalJson(prompt)),
        }),
      );
      if (decision.confidence === "high" && decision.probability >= 0.85)
        relation = z
          .enum(["same", "different", "unknown"])
          .parse(
            decision.selectedIndex === null
              ? "unknown"
              : prompt.choices[decision.selectedIndex],
          );
    }
    dimensions.push({
      dimension,
      first: selected[0] ?? null,
      second: selected[1] ?? null,
      relation,
      decisions,
    });
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

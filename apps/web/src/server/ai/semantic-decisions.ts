import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";
import {
  selectDecisionModel,
  type SupportedDecisionModel,
} from "@cubby/shared/ai/models";

import {
  type DecisionChoicePrompt,
  type DecisionChoiceResult,
  type DecisionPort,
  decisionChoiceFitsContext,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import {
  IMAGE_PROVENANCE_CLASSIFICATION_FEATURE,
  PRODUCT_VARIANT_RELATION_FEATURE,
  UPC_OFFER_COMPARABILITY_FEATURE,
} from "~/server/ai/features";
import {
  IMAGE_PROVENANCE_CHOICES,
  imageProvenancePrompt,
  PRODUCT_VARIANT_RELATION_CHOICES,
  productVariantRelationPrompt,
  UPC_OFFER_COMPARABILITY_CHOICES,
  upcOfferComparabilityPrompt,
  type ImageProvenanceDecisionInput,
  type ProductVariantRelationChoice,
} from "~/server/ai/prompts/semantic-decisions";
import type { AiRunContext } from "~/server/ai/run-feature";

const choice = async <Value extends string>(args: {
  feature: Parameters<typeof runDecisionChoice>[0]["feature"];
  prompt: DecisionChoicePrompt;
  values: readonly Value[];
  usage: AiRunContext;
  port?: DecisionPort;
  decisionModel?: SupportedDecisionModel;
}): Promise<{ value: Value | null; result: DecisionChoiceResult }> => {
  if (
    !decisionChoiceFitsContext({
      ...args.prompt,
      choices: args.values,
      allowNone: false,
    })
  ) {
    return {
      value: null,
      result: {
        selectedIndex: null,
        confidence: "low",
        probability: 0,
        ranked: [],
      },
    };
  }
  const result = await runDecisionChoice({
    feature: args.feature,
    ...args.prompt,
    usage: args.usage,
    allowNone: false,
    decisionModel: args.decisionModel ?? selectDecisionModel(),
    port: args.port,
  });
  const selected =
    result.confidence === "high" && result.selectedIndex !== null
      ? args.values[result.selectedIndex]
      : undefined;
  return { value: selected ?? null, result };
};

export async function decideUpcOfferComparability(args: {
  itemTitle: string;
  offerTitle: string;
  usage: AiRunContext;
  port?: DecisionPort;
}) {
  if (args.itemTitle.length > 400 || args.offerTitle.length > 400)
    return "unknown" as const;
  const result = await choice({
    feature: UPC_OFFER_COMPARABILITY_FEATURE,
    prompt: upcOfferComparabilityPrompt(args),
    values: UPC_OFFER_COMPARABILITY_CHOICES,
    usage: args.usage,
    port: args.port,
  });
  return result.value ?? "unknown";
}

export async function decideImageProvenance(args: {
  input: ImageProvenanceDecisionInput;
  usage: AiRunContext;
  port?: DecisionPort;
}) {
  if (!imageProvenanceInputIsComplete(args.input)) return "unknown" as const;
  const result = await choice({
    feature: IMAGE_PROVENANCE_CLASSIFICATION_FEATURE,
    prompt: imageProvenancePrompt(args.input),
    values: IMAGE_PROVENANCE_CHOICES,
    usage: args.usage,
    port: args.port,
  });
  return result.value ?? "unknown";
}

export async function decideImageProvenanceWithEvidence(args: {
  input: ImageProvenanceDecisionInput;
  usage: AiRunContext;
  port?: DecisionPort;
}) {
  if (!imageProvenanceInputIsComplete(args.input)) {
    return {
      value: "unknown" as const,
      confidence: "low" as const,
      probability: 0,
      model: selectDecisionModel(),
      feature: IMAGE_PROVENANCE_CLASSIFICATION_FEATURE.feature,
      promptVersion: IMAGE_PROVENANCE_CLASSIFICATION_FEATURE.promptVersion,
    };
  }
  const decisionModel = selectDecisionModel();
  const result = await choice({
    feature: IMAGE_PROVENANCE_CLASSIFICATION_FEATURE,
    prompt: imageProvenancePrompt(args.input),
    values: IMAGE_PROVENANCE_CHOICES,
    usage: args.usage,
    port: args.port,
    decisionModel,
  });
  return {
    value: result.value ?? "unknown",
    confidence: result.result.confidence,
    probability: result.result.probability,
    model: decisionModel,
    feature: IMAGE_PROVENANCE_CLASSIFICATION_FEATURE.feature,
    promptVersion: IMAGE_PROVENANCE_CLASSIFICATION_FEATURE.promptVersion,
  } as const;
}

function imageProvenanceInputIsComplete(
  input: ImageProvenanceDecisionInput,
): boolean {
  return (
    (input.filename?.length ?? 0) <= 120 &&
    (input.sourceAssetUrl?.length ?? 0) <= 300 &&
    (input.sourcePageUrl?.length ?? 0) <= 300 &&
    (input.sourceName?.length ?? 0) <= 120 &&
    input.sightingSourceTypes.length <= 6 &&
    (input.analysisSummary?.length ?? 0) <= 240
  );
}

const RELATIONS_BY_CHOICE = {
  "color same; size same": { color: "same", size: "same" },
  "color same; size different": { color: "same", size: "different" },
  "color same; size unknown": { color: "same", size: "unknown" },
  "color different; size same": { color: "different", size: "same" },
  "color different; size different": { color: "different", size: "different" },
  "color different; size unknown": { color: "different", size: "unknown" },
  "color unknown; size same": { color: "unknown", size: "same" },
  "color unknown; size different": { color: "unknown", size: "different" },
  "color unknown; size unknown": { color: "unknown", size: "unknown" },
} as const satisfies Record<
  ProductVariantRelationChoice,
  {
    color: ProductVariantComparison["color"]["relation"];
    size: ProductVariantComparison["size"]["relation"];
  }
>;

export async function decideProductVariantComparison(args: {
  firstTitle: string;
  secondTitle: string;
  usage: AiRunContext;
  port?: DecisionPort;
}) {
  if (args.firstTitle.length > 500 || args.secondTitle.length > 500)
    return {
      color: { relation: "unknown" as const },
      size: { relation: "unknown" as const },
      evidence: { firstTitle: args.firstTitle, secondTitle: args.secondTitle },
    };
  const result = await choice({
    feature: PRODUCT_VARIANT_RELATION_FEATURE,
    prompt: productVariantRelationPrompt(args),
    values: PRODUCT_VARIANT_RELATION_CHOICES,
    usage: args.usage,
    port: args.port,
  });
  const relations = result.value
    ? RELATIONS_BY_CHOICE[result.value]
    : { color: "unknown" as const, size: "unknown" as const };
  return {
    color: { relation: relations.color },
    size: { relation: relations.size },
    evidence: { firstTitle: args.firstTitle, secondTitle: args.secondTitle },
  };
}

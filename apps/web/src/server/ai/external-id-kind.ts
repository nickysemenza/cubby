/**
 * `ai.suggestExternalIdKind`: classify one external identifier's `kind` from
 * its shape and source. Three shapes are unambiguous — an ASIN's `B0`
 * prefix, a barcode's digit count, Home Depot's 9-digit internet number —
 * and resolve at `probability: 1` with no model call. Everything else (a
 * manufacturer's own item number, a distributor's catalog number, a
 * retailer's SKU) is genuine judgment and goes to the decision model, same as every other
 * enum `control.suggest` target (`field-suggest/registry.ts`), except this
 * one has no manifest field behind it — `externalIds[]` is a repeatable
 * array, not a singular reference/enum column `resolveEnumTarget` can name.
 */
import type {
  ExternalIdKindSuggestionInput,
  FieldSuggestion,
} from "@cubby/schemas/ai";
import {
  externalIdKind,
  type ExternalIdKind,
} from "@cubby/schemas/external-id";
import { isGtin } from "@cubby/shared/upc";

import { classifyWithDecisionModel } from "~/server/ai/classify";
import type { DecisionPort } from "~/server/ai/decision-model";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/features";
import type { AiRunContext } from "~/server/ai/run-feature";
import {
  EXTERNAL_ID_KIND_DESCRIPTIONS,
  EXTERNAL_ID_KIND_RULES,
} from "~/server/ai/vocabularies";

/** Home Depot's non-barcode SKU: distinct from the barcode it also carries. */
const HOME_DEPOT_INTERNET_NUMBER_LENGTH = 9;

function regexFastPath(
  input: ExternalIdKindSuggestionInput,
): ExternalIdKind | null {
  const source = input.source.trim().toLowerCase();
  const identifier = input.identifier.trim();
  if (source === "amazon" && /^B0[A-Z0-9]{8}$/.test(identifier)) return "asin";
  if (
    source === "home-depot" &&
    /^\d+$/.test(identifier) &&
    identifier.length === HOME_DEPOT_INTERNET_NUMBER_LENGTH
  ) {
    return "internet_number";
  }
  if (isGtin(identifier)) return "gtin_14";
  return null;
}

export function externalIdKindSubject(
  input: ExternalIdKindSuggestionInput,
): string {
  return [
    `Source: "${input.source}"`,
    `Identifier: "${input.identifier}"`,
    input.url ? `URL: "${input.url}"` : null,
    input.productName ? `Product name: "${input.productName}"` : null,
    input.manufacturer ? `Manufacturer: "${input.manufacturer}"` : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

export async function suggestExternalIdKind(
  input: ExternalIdKindSuggestionInput,
  usage: AiRunContext,
  ports?: { decisionPort?: DecisionPort },
): Promise<FieldSuggestion | null> {
  const fastKind = regexFastPath(input);
  if (fastKind) {
    return {
      value: fastKind,
      label: fastKind,
      detail: null,
      confidence: "high",
      probability: 1,
      reasoning: "",
      alternatives: [],
      operation: "set",
      removals: [],
    };
  }

  const result = await classifyWithDecisionModel({
    feature: FIELD_SUGGESTION_FEATURE,
    subject: externalIdKindSubject(input),
    rules: EXTERNAL_ID_KIND_RULES,
    values: externalIdKind.options,
    describe: (value) => EXTERNAL_ID_KIND_DESCRIPTIONS[value],
    usage: { ...usage, operation: "suggestExternalIdKind" },
    port: ports?.decisionPort,
  });
  return {
    value: result.value,
    label: result.value,
    detail: null,
    confidence: result.confidence,
    probability: result.probability,
    reasoning: result.reasoning,
    alternatives: result.alternatives.map((alternative) => ({
      value: alternative.value,
      label: alternative.value,
      detail: null,
      probability: alternative.probability,
    })),
    operation: "set",
    removals: [],
  };
}

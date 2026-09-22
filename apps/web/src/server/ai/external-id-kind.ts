/**
 * `ai.suggestExternalIdKind`: classify one external identifier's `kind` from
 * its shape and source. Three shapes are unambiguous — an ASIN's `B0`
 * prefix, a barcode's digit count, Home Depot's 9-digit internet number —
 * and resolve at `probability: 1` with no model call. Everything else (a
 * manufacturer's own item number, a distributor's catalog number, a
 * retailer's SKU) is genuine judgment and goes to Jev, same as every other
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

import { classifyWithJev } from "~/server/ai/classify";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/features";
import type { JevPort } from "~/server/ai/jev";
import type { AiRunContext } from "~/server/ai/run-feature";
import {
  EXTERNAL_ID_KIND_DESCRIPTIONS,
  EXTERNAL_ID_KIND_RULES,
} from "~/server/ai/vocabularies";

/** Every kind Jev may choose between — `legacy_unspecified` is a migration
 * artifact a model should never propose. */
const JEV_KINDS = externalIdKind.options.filter(
  (kind): kind is Exclude<ExternalIdKind, "legacy_unspecified"> =>
    kind !== "legacy_unspecified",
);

/** Home Depot's non-barcode SKU: distinct from the barcode it also carries. */
const HOME_DEPOT_INTERNET_NUMBER_LENGTH = 9;

function regexFastPath(
  input: ExternalIdKindSuggestionInput,
): ExternalIdKind | null {
  const source = input.source.trim().toLowerCase();
  const identifier = input.identifier.trim();
  if (source === "amazon" && /^B0[A-Z0-9]{8}$/.test(identifier)) return "asin";
  if (/^\d{8,14}$/.test(identifier)) {
    return source === "home-depot" &&
      identifier.length === HOME_DEPOT_INTERNET_NUMBER_LENGTH
      ? "internet_number"
      : "gtin_14";
  }
  return null;
}

function subjectFor(input: ExternalIdKindSuggestionInput): string {
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
  ports?: { jev?: JevPort },
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

  const result = await classifyWithJev({
    feature: FIELD_SUGGESTION_FEATURE,
    subject: subjectFor(input),
    rules: EXTERNAL_ID_KIND_RULES,
    values: JEV_KINDS,
    describe: (value) => EXTERNAL_ID_KIND_DESCRIPTIONS[value],
    usage: { ...usage, operation: "suggestExternalIdKind" },
    port: ports?.jev,
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

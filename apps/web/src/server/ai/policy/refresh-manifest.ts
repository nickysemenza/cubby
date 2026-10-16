import {
  aiRefreshManifest,
  type AiRefreshManifest,
  type AiProvenance,
} from "@cubby/schemas/ai-evaluation";
import { MAILBOX_RESEARCH_VERSION } from "@cubby/schemas/mailbox-research";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import {
  AI_FEATURES,
  MAILBOX_TRIAGE_FEATURE,
  MAILBOX_RELEVANCE_FEATURE,
  SELECTION_OVERFLOW_FEATURE,
} from "./features";
import { fieldDecisionRows } from "./field-decisions";

const automaticFeatures = new Set([
  "field-suggestion",
  "product-identity",
  "selection-overflow",
  "mailbox-triage",
  "mailbox-relevance",
]);
export const fieldPolicyKey = (entity: string, field: string) =>
  `field:${entity}.${field}`;

export async function compiledRefreshManifest(): Promise<AiRefreshManifest> {
  const entries: AiRefreshManifest = {};
  const templates = new Map<string, unknown>([
    [
      MAILBOX_TRIAGE_FEATURE.feature,
      {
        prompt: MAILBOX_TRIAGE_FEATURE.prompt("Synthetic message"),
        routingVersion: MAILBOX_RESEARCH_VERSION,
      },
    ],
    [
      MAILBOX_RELEVANCE_FEATURE.feature,
      {
        request: MAILBOX_RELEVANCE_FEATURE.request("Synthetic message"),
        schema: z.toJSONSchema(MAILBOX_RELEVANCE_FEATURE.schema),
        routingVersion: MAILBOX_RESEARCH_VERSION,
      },
    ],
    [
      SELECTION_OVERFLOW_FEATURE.feature,
      {
        request: SELECTION_OVERFLOW_FEATURE.request(
          "Synthetic rules",
          "Synthetic subject",
          "synthetic-option",
        ),
        schema: z.toJSONSchema(SELECTION_OVERFLOW_FEATURE.schema),
      },
    ],
  ]);
  for (const feature of AI_FEATURES) {
    if (!automaticFeatures.has(feature.feature)) continue;
    entries[feature.feature] = {
      promptVersion: feature.promptVersion,
      generation: 0,
      policyFingerprint: await sha256Hex(
        JSON.stringify({
          tier: feature.tier,
          model: feature.model,
          effort: "effort" in feature ? feature.effort : null,
          maxTokens: "maxTokens" in feature ? feature.maxTokens : null,
          promptVersion: feature.promptVersion,
          template: templates.get(feature.feature),
        }),
      ),
    };
  }
  for (const row of fieldDecisionRows()) {
    if (!row.field || !row.entity) continue;
    entries[fieldPolicyKey(row.entity, row.field)] = {
      promptVersion: row.promptVersion,
      generation: 0,
      policyFingerprint: await sha256Hex(
        JSON.stringify({
          mode: row.mode,
          rules: row.rules,
          options: row.options,
          basis: row.basis,
          prompt: row.prompt,
          roster: row.roster,
        }),
      ),
    };
  }
  return aiRefreshManifest.parse(entries);
}

export function dependencyStamps(
  manifest: AiRefreshManifest,
  features: readonly string[],
): AiProvenance["dependencies"] {
  return [...new Set(features)]
    .sort()
    .flatMap((feature) =>
      manifest[feature] ? [{ feature, ...manifest[feature] }] : [],
    );
}

export function dependenciesCurrent(
  provenance: AiProvenance,
  manifest: AiRefreshManifest,
) {
  return provenance.dependencies.every((stamp) => {
    const active = manifest[stamp.feature];
    return (
      active &&
      active.promptVersion === stamp.promptVersion &&
      active.policyFingerprint === stamp.policyFingerprint &&
      active.generation === stamp.generation
    );
  });
}

export function fieldDependencyKeys(entity: string, field: string) {
  const policy = fieldDecisionRows().find(
    (row) => row.entity === entity && row.field === field,
  );
  return [
    "field-suggestion",
    fieldPolicyKey(entity, field),
    ...(policy?.roster ? ["selection-overflow"] : []),
  ];
}

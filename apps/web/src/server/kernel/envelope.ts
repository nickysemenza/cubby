/**
 * The canonical input envelope of section 1: feature, producer, requested
 * tier or model policy, output-schema revision, producer parameters,
 * `promptVersion` and the declared input. `inputHash` is its SHA-256 over
 * canonical JSON, so a funding-route substitution keeps the hash and a
 * deliberate tier change does not.
 */
import { z } from "zod";

import type { AskKind } from "./define";
import { canonicalJson, hashCanonical } from "./keys";
import { KernelContractError } from "./reads";

const outputRevisions = new WeakMap<AskKind, string>();

function outputRevision(kind: AskKind): string {
  if (kind.policy.outputRevision) return kind.policy.outputRevision;
  const cached = outputRevisions.get(kind);
  if (cached) return cached;
  let revision: string;
  try {
    revision = canonicalJson(z.toJSONSchema(kind.output));
  } catch (error) {
    throw new KernelContractError(
      `Ask ${kind.feature} has an output schema with no JSON Schema form; declare policy.outputRevision`,
      { cause: error },
    );
  }
  outputRevisions.set(kind, revision);
  return revision;
}

export type AskEnvelope = {
  feature: string;
  producer: string;
  tier: string | null;
  model: string | null;
  outputRevision: string;
  parameters: unknown;
  promptVersion: string;
  input: unknown;
};

/** The envelope of one declared input; the input is parsed first. */
export function askEnvelope(kind: AskKind, input: unknown): AskEnvelope {
  return {
    feature: kind.feature,
    producer: kind.producer,
    tier: kind.policy.tier ?? null,
    model: kind.policy.model ?? null,
    outputRevision: outputRevision(kind),
    parameters: kind.policy.parameters ?? null,
    promptVersion: kind.promptVersion,
    input: kind.input.parse(input),
  };
}

/** Synchronous identity for in-memory lookups; the hash is its digest. */
export const envelopeText = (envelope: AskEnvelope) => canonicalJson(envelope);
export const inputHashOf = (envelope: AskEnvelope) => hashCanonical(envelope);

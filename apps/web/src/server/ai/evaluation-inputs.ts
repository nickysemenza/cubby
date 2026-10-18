import { AsyncLocalStorage } from "node:async_hooks";

import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { AiFeature } from "./policy/features";

const capturedInput = z.object({
  feature: z.string(),
  promptVersion: z.string(),
  operation: z.string(),
  model: z.string(),
  fingerprint: z.string(),
});
export type CapturedInput = z.infer<typeof capturedInput>;
const scope = new AsyncLocalStorage<{
  prepareOnly: boolean;
  providerFree: boolean;
  /** Set when a provider-free preparation skipped an input it needed. */
  incomplete: boolean;
  inputs: CapturedInput[];
}>();

/** Preparation uses the live roster/rendering path, but makes no transport or usage call. */
export const preparingAiInputs = () => scope.getStore()?.prepareOnly === true;

/**
 * True inside a provider-free preparation, which must not make any paid
 * provider call (a cold query embedding included). A caller that needs one
 * returns its no-provider fallback and records that the prepared inputs are
 * incomplete, so they are never treated as equal to a live answer's.
 */
export const preparingWithoutProviders = () =>
  scope.getStore()?.providerFree === true;
export const markPreparationIncomplete = () => {
  const current = scope.getStore();
  if (current?.providerFree) current.incomplete = true;
};
export async function captureAiInput(
  feature: Pick<AiFeature, "feature" | "promptVersion" | "model">,
  operation: string,
  input: unknown,
) {
  const current = scope.getStore();
  if (!current) return;
  current.inputs.push({
    feature: feature.feature,
    promptVersion: feature.promptVersion,
    model: feature.model,
    operation,
    fingerprint: await sha256Hex(JSON.stringify(z.json().parse(input))),
  });
}
export async function withAiInputs<T>(
  prepareOnly: boolean,
  work: () => Promise<T>,
  options: { providerFree?: boolean } = {},
) {
  const parent = scope.getStore();
  const store = {
    prepareOnly,
    providerFree: prepareOnly && options.providerFree === true,
    incomplete: false,
    inputs: new Array<CapturedInput>(),
  };
  const result = await scope.run(store, work);
  parent?.inputs.push(...store.inputs);
  return { result, inputs: store.inputs, incomplete: store.incomplete };
}

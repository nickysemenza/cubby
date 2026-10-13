import { AsyncLocalStorage } from "node:async_hooks";

import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { AiFeature } from "./features";

const capturedInput = z.object({
  feature: z.string(),
  promptVersion: z.string(),
  operation: z.string(),
  model: z.string(),
  fingerprint: z.string(),
});
type CapturedInput = z.infer<typeof capturedInput>;
const scope = new AsyncLocalStorage<{
  prepareOnly: boolean;
  inputs: CapturedInput[];
}>();

/** Preparation uses the live roster/rendering path, but makes no transport or usage call. */
export const preparingAiInputs = () => scope.getStore()?.prepareOnly === true;
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
) {
  const parent = scope.getStore();
  const inputs: CapturedInput[] = [];
  const result = await scope.run({ prepareOnly, inputs }, work);
  parent?.inputs.push(...inputs);
  return { result, inputs };
}

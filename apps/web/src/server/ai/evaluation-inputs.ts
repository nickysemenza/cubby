import { AsyncLocalStorage } from "node:async_hooks";

import { capturedFieldInput } from "@cubby/schemas/ai-evaluation";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { AiFeature } from "./policy/features";

export const preparedQuestion = z.object({
  feature: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  operation: z.string(),
  input: z.json(),
});
const capturedInput = capturedFieldInput;
export type CapturedInput = z.infer<typeof capturedInput>;
const scope = new AsyncLocalStorage<{
  prepareOnly: boolean;
  providerFree: boolean;
  /** Set when a provider-free preparation skipped an input it needed. */
  incomplete: boolean;
  inputs: CapturedInput[];
  questions: z.infer<typeof preparedQuestion>[];
  expected?: readonly z.infer<typeof preparedQuestion>[];
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
  const question = preparedQuestion.parse({
    ...feature,
    operation,
    input: z.json().parse(input),
  });
  if (
    current.expected &&
    !current.expected.some(
      (expected) => JSON.stringify(expected) === JSON.stringify(question),
    )
  )
    throw new Error("The prepared field question changed before send");
  current.questions.push(question);
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
  options: {
    providerFree?: boolean;
    captureToParent?: boolean;
    expected?: readonly z.infer<typeof preparedQuestion>[];
  } = {},
) {
  const parent = scope.getStore();
  const store = {
    prepareOnly,
    providerFree: options.providerFree === true,
    incomplete: false,
    inputs: new Array<CapturedInput>(),
    questions: new Array<z.infer<typeof preparedQuestion>>(),
    expected: options.expected,
  };
  const result = await scope.run(store, work);
  if (options.captureToParent !== false) parent?.inputs.push(...store.inputs);
  return {
    result,
    inputs: store.inputs,
    questions: store.questions,
    incomplete: store.incomplete,
  };
}

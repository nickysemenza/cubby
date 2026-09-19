/**
 * One exhaustive closed-set classification on the decision tier: Jev picks
 * over value-labeled choices with no `none` (every product has a category,
 * every location a type), and the winner's index maps back to the value.
 * Jev writes no prose, so `reasoning` is the empty string the wire shape
 * requires.
 *
 * Moved out of `clients/ai.ts` so both `AiClient`'s two decision-tier
 * methods and `field-suggest/suggest-fields.ts`'s enum targets share the one
 * implementation.
 */
import type { Confidence } from "@cubby/schemas/ai";

import type { AiDecisionFeature } from "~/server/ai/features";
import { type JevPort, runJevChoice } from "~/server/ai/jev";
import type { AiRunContext } from "~/server/ai/run-feature";

export async function classifyWithJev<Value extends string>(args: {
  feature: AiDecisionFeature;
  subject: string;
  rules: string;
  values: readonly Value[];
  describe: (value: Value) => string;
  usage: AiRunContext;
  port?: JevPort;
}): Promise<{
  value: Value;
  confidence: Confidence;
  probability: number;
  reasoning: "";
}> {
  const { selectedIndex, confidence, probability } = await runJevChoice({
    feature: args.feature,
    subject: args.subject,
    rules: args.rules,
    choices: args.values.map((value) => `${value}: ${args.describe(value)}`),
    usage: args.usage,
    allowNone: false,
    port: args.port,
  });
  const value = selectedIndex === null ? undefined : args.values[selectedIndex];
  if (value === undefined) {
    throw new Error("Jev classification returned no value.");
  }
  return { value, confidence, probability, reasoning: "" };
}

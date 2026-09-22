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

/** One runner-up: the caller (`resolveEnumTarget`) applies its own
 * `labelOf`/`describe` to render this into the wire's `label`/`detail`. */
export interface ClassifyAlternative<Value extends string> {
  value: Value;
  probability: number;
}

/** Top-3 runners-up (after the winner) from Jev's ranked distribution,
 * mapped back to the roster's own values. Empty when `runJevChoice` has
 * nothing to rank (an exhaustive vocabulary of one). */
function alternativesFrom<Value extends string>(
  ranked: { index: number; probability: number }[],
  selectedIndex: number | null,
  values: readonly Value[],
): ClassifyAlternative<Value>[] {
  return ranked
    .filter((entry) => entry.index !== selectedIndex)
    .slice(0, 3)
    .flatMap((entry) => {
      const value = values[entry.index];
      return value === undefined
        ? []
        : [{ value, probability: entry.probability }];
    });
}

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
  alternatives: ClassifyAlternative<Value>[];
}> {
  const { selectedIndex, confidence, probability, ranked } = await runJevChoice(
    {
      feature: args.feature,
      subject: args.subject,
      rules: args.rules,
      choices: args.values.map((value) => `${value}: ${args.describe(value)}`),
      usage: args.usage,
      allowNone: false,
      port: args.port,
    },
  );
  const value = selectedIndex === null ? undefined : args.values[selectedIndex];
  if (value === undefined) {
    throw new Error("Jev classification returned no value.");
  }
  return {
    value,
    confidence,
    probability,
    reasoning: "",
    alternatives: alternativesFrom(ranked, selectedIndex, args.values),
  };
}

/**
 * Closed-set classification on the decision tier: exhaustive callers require
 * a value; suggestion targets may opt into an evaluated `none` outcome.
 * The decision model writes no prose, so `reasoning` is the empty string the wire shape
 * requires.
 *
 * Moved out of `clients/ai.ts` so both `AiClient`'s two decision-tier
 * methods and `field-suggest/suggest-fields.ts`'s enum targets share the one
 * implementation.
 */
import {
  type DecisionChoicePrompt,
  runDecisionChoice,
} from "~/server/ai/decision-model";

type ClassificationInput<Value extends string> = Omit<
  Parameters<typeof runDecisionChoice>[0],
  "choices" | "allowNone"
> & {
  values: readonly Value[];
  describe: (value: Value) => string;
  allowNone?: boolean;
};

type ClassificationResult<Value extends string> = Pick<
  Awaited<ReturnType<typeof runDecisionChoice>>,
  "confidence" | "probability"
> & {
  value: Value | null;
  reasoning: "";
  alternatives: ClassifyAlternative<Value>[];
};

/** One runner-up: the caller (`resolveEnumTarget`) applies its own
 * `labelOf`/`describe` to render this into the wire's `label`/`detail`. */
interface ClassifyAlternative<Value extends string> {
  value: Value;
  probability: number;
}

/** Top-3 runners-up (after the winner) from the decision model's ranked distribution,
 * mapped back to the roster's own values. Empty when `runDecisionChoice` has
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

/** The choice an enum classification asks; the Decisions catalog
 * renders the same prompt. */
export function classificationPrompt<Value extends string>(args: {
  subject: string;
  rules: string;
  values: readonly Value[];
  describe: (value: Value) => string;
  allowNone?: boolean;
}): DecisionChoicePrompt {
  return {
    subject: args.subject,
    rules: args.rules,
    choices: args.values.map((value) => `${value}: ${args.describe(value)}`),
    allowNone: args.allowNone ?? false,
  };
}

export function classifyWithDecisionModel<Value extends string>(
  args: ClassificationInput<Value> & { allowNone?: false },
): Promise<Omit<ClassificationResult<Value>, "value"> & { value: Value }>;
export function classifyWithDecisionModel<Value extends string>(
  args: ClassificationInput<Value>,
): Promise<ClassificationResult<Value>>;
export async function classifyWithDecisionModel<Value extends string>(
  args: ClassificationInput<Value>,
): Promise<ClassificationResult<Value>> {
  const { selectedIndex, confidence, probability, ranked } =
    await runDecisionChoice({
      feature: args.feature,
      ...classificationPrompt(args),
      usage: args.usage,
      port: args.port,
      decisionModel: args.decisionModel,
      onTokenUsage: args.onTokenUsage,
    });
  const value = selectedIndex === null ? undefined : args.values[selectedIndex];
  if (value === undefined && !args.allowNone) {
    throw new Error("Decision-model classification returned no value.");
  }
  return {
    value: value ?? null,
    confidence,
    probability,
    reasoning: "",
    alternatives: alternativesFrom(ranked, selectedIndex, args.values),
  };
}

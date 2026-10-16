/**
 * One generic "shortlist → single pick" helper.
 *
 * Location suggestion, USDA food matching, and ingredient-merge suggestion
 * were three near-identical flows: assemble a shortlist of candidates and
 * ask for exactly one (or none). Each consumer declares an
 * {@link AiSelectionSpec} ("one declaration, several consumers",
 * docs/entities.md) instead of re-implementing the call, and never learns
 * which model answered:
 *
 * - A roster the decision tier can take in one choice goes to the decision model
 *   (`decision-model.ts`), which answers over positional `c0…cn` choices — the
 *   winner's index resolves straight back to the shown roster.
 * - A roster exceeding the choice or byte budget overflows to the fast chat tier
 *   ({@link SELECTION_OVERFLOW_FEATURE}): the model names the chosen
 *   candidate's id from a rendered shortlist, and an id it never saw
 *   resolves to null rather than to a guess.
 */
import type { AiSelectionResult, Confidence } from "@cubby/schemas/ai";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";

import {
  decisionChoiceFitsContext,
  type DecisionPort,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import {
  type AiSelectionSpec,
  selectionPrompt,
} from "~/server/ai/policy/decision-choice";
import { SELECTION_OVERFLOW_FEATURE } from "~/server/ai/policy/features";
import {
  type AiRunContext,
  runStructuredFeature,
} from "~/server/ai/run-feature";

/**
 * The run context a `runAiSelection` caller supplies. The feature record —
 * and with it the model and cache policy — comes from the spec, so a caller
 * only names the operation and the entity it is about.
 */
export type AiSelectionUsage = AiRunContext;

/** The overflow call a spec's consumer fakes in tests instead of the network. */
export interface AiSelectionPort {
  select(args: {
    rules: string;
    subject: string;
    shortlist: string;
    usage: AiSelectionUsage;
  }): Promise<AiSelectionResult>;
}

const productionAiSelectionPort: AiSelectionPort = {
  select: async ({ rules, subject, shortlist, usage }) =>
    runStructuredFeature(
      SELECTION_OVERFLOW_FEATURE,
      SELECTION_OVERFLOW_FEATURE.request(rules, subject, shortlist),
      usage,
    ),
};

export interface AiSelectionOutcome<C> {
  selected: C | null;
  confidence: Confidence;
  /** The decision model's calibrated probability, unavailable for overflow chat picks. */
  probability: number | null;
  /** Empty for a decision-tier pick, which writes no prose. */
  reasoning: string;
  /** Top-3 runners-up (after `selected`), from the decision model's ranked distribution.
   * Always `[]` on the overflow/chat-tier path — a prose pick has no
   * distribution to rank — and when there were no candidates to choose from. */
  alternatives: { candidate: C; probability: number }[];
  /** The decision model's full ranked distribution over the shown candidates (winner
   * included, `none` excluded). `[]` wherever `alternatives` is. */
  distribution: { candidate: C; probability: number }[];
  /** False only when there were no candidates to show, so no model was asked. */
  evaluated: boolean;
}

/** The overflow model is copying an id out of prose; tolerate the
 * whitespace/case noise that introduces rather than reject an
 * otherwise-correct answer. */
const normalizeId = (id: string): string => id.trim().toLowerCase();

/**
 * Truncate `candidates` to `spec.maxCandidates` and ask the model to pick
 * one. Never calls a model when there are no candidates. The returned
 * `selected` is always one of the candidates the model actually saw; a
 * `none`/null answer resolves to null with the model's own confidence.
 */
export async function runAiSelection<C>(
  spec: AiSelectionSpec<C>,
  args: {
    subject: string;
    candidates: readonly C[];
    usage: AiSelectionUsage;
    decisionPort?: DecisionPort;
    decisionModel?: SupportedDecisionModel;
    ai?: AiSelectionPort;
  },
): Promise<AiSelectionOutcome<C>> {
  const shown = args.candidates.slice(0, spec.maxCandidates);
  if (shown.length === 0) {
    return {
      selected: null,
      confidence: "low",
      probability: null,
      reasoning: "No candidates were available to choose from.",
      alternatives: [],
      distribution: [],
      evaluated: false,
    };
  }

  const prompt = selectionPrompt(spec, args.subject, shown);
  const { choices } = prompt;
  if (!decisionChoiceFitsContext(prompt)) {
    const port = args.ai ?? productionAiSelectionPort;
    const result = await port.select({
      rules: spec.rules,
      subject: args.subject,
      shortlist: shown
        .map((candidate, index) => `${spec.idOf(candidate)}: ${choices[index]}`)
        .join("\n"),
      usage: args.usage,
    });
    const wanted =
      result.selectedId == null ? null : normalizeId(result.selectedId);
    return {
      selected:
        wanted === null
          ? null
          : (shown.find((c) => normalizeId(spec.idOf(c)) === wanted) ?? null),
      confidence: result.confidence,
      probability: null,
      reasoning: result.reasoning,
      alternatives: [],
      distribution: [],
      evaluated: true,
    };
  }

  const result = await runDecisionChoice({
    feature: spec.feature,
    ...prompt,
    usage: args.usage,
    port: args.decisionPort,
    decisionModel: args.decisionModel,
  });
  const distribution = result.ranked.flatMap((entry) => {
    const candidate = shown[entry.index];
    return candidate === undefined
      ? []
      : [{ candidate, probability: entry.probability }];
  });
  const selectedCandidate =
    result.selectedIndex === null ? undefined : shown[result.selectedIndex];
  const alternatives = distribution
    .filter((entry) => entry.candidate !== selectedCandidate)
    .slice(0, 3);
  return {
    selected:
      result.selectedIndex === null
        ? null
        : (shown[result.selectedIndex] ?? null),
    confidence: result.confidence,
    probability: result.probability,
    reasoning: "",
    alternatives,
    distribution,
    evaluated: true,
  };
}

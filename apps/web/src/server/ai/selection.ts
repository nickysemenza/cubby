/**
 * One generic "shortlist → single structured pick" helper.
 *
 * Location suggestion, USDA food matching, and ingredient-merge suggestion
 * were three near-identical flows: assemble a shortlist of candidates, ask
 * the fast tier to name exactly one (or none), and resolve that answer back
 * to a real candidate — rejecting an id the model never actually saw. USDA
 * match and ingredient merge used to run this as a multi-turn agentic tool
 * loop (the model searched for itself); both now build their shortlist up
 * front and spend exactly one structured call here, same as location
 * suggestion always did. Each consumer declares an {@link AiSelectionSpec}
 * ("one declaration, several consumers", docs/entities.md) instead of
 * re-implementing the call.
 */
import type { AiSelectionResult, Confidence } from "@cubby/schemas/ai";

import type { AiStructuredFeature } from "~/server/ai/features";
import {
  type AiRunContext,
  runStructuredFeature,
} from "~/server/ai/run-feature";

/**
 * The run context a `runAiSelection` caller supplies. The feature record —
 * and with it the tier, token cap, effort, and cache policy — comes from the
 * spec, so a caller only names the operation and the entity it is about.
 */
export type AiSelectionUsage = AiRunContext;

/** Every selection asks for the same structured answer. */
type AiSelectionFeature = AiStructuredFeature<AiSelectionResult>;

/**
 * One consumer's declaration: which feature record it runs on, what it
 * selects over, how one candidate becomes a shortlist line, how to read a
 * candidate's stable id back out, its feature-specific prompt rules, and how
 * many candidates the model is ever shown.
 */
export interface AiSelectionSpec<C> {
  /** The `features.ts` record this selection runs as. */
  feature: AiSelectionFeature;
  /**
   * The feature-specific prompt paragraph — lifted verbatim from the
   * tool-loop prompt it replaces, minus the tool-calling instructions. Sits
   * alongside the shared frame and the rendered shortlist as its own system
   * prompt.
   */
  rules: string;
  /** The stable id the model is asked to echo back to name its choice. */
  idOf: (candidate: C) => string;
  /** One shortlist line for one candidate, in the spec's own format. */
  renderLine: (candidate: C) => string;
  /** Candidates beyond this many are never rendered or shown to the model. */
  maxCandidates: number;
}

/** The one call a spec's consumer fakes in tests instead of the network. */
export interface AiSelectionPort {
  select(args: {
    feature: AiSelectionFeature;
    rules: string;
    subject: string;
    shortlist: string;
    usage: AiSelectionUsage;
  }): Promise<AiSelectionResult>;
}

const SELECTION_FRAME =
  "You are given a subject and a numbered shortlist. Choose exactly one entry's id, or null when none fits.";

const productionAiSelectionPort: AiSelectionPort = {
  select: async ({ feature, rules, subject, shortlist, usage }) =>
    runStructuredFeature(
      feature,
      {
        systemPrompts: [SELECTION_FRAME, rules, `Shortlist:\n${shortlist}`],
        messages: [{ role: "user", content: subject }],
      },
      usage,
    ),
};

export interface AiSelectionOutcome<C> {
  selected: C | null;
  confidence: Confidence;
  reasoning: string;
}

/** The model is copying an id out of prose; tolerate the whitespace/case
 * noise that introduces rather than reject an otherwise-correct answer. */
const normalizeId = (id: string): string => id.trim().toLowerCase();

/**
 * Truncate `candidates` to `spec.maxCandidates`, render them as a shortlist,
 * and ask the model to pick one. Never calls the model when there are no
 * candidates. The returned `selected` is always one of the (possibly
 * truncated) candidates the model actually saw — an invented id, or one
 * beyond the truncation, resolves to `null` while the model's own confidence
 * and reasoning are still returned, so a caller can decide how to surface a
 * hallucinated answer.
 */
export async function runAiSelection<C>(
  spec: AiSelectionSpec<C>,
  args: {
    subject: string;
    candidates: readonly C[];
    usage: AiSelectionUsage;
    ai?: AiSelectionPort;
  },
): Promise<AiSelectionOutcome<C>> {
  const shown = args.candidates.slice(0, spec.maxCandidates);
  if (shown.length === 0) {
    return {
      selected: null,
      confidence: "low",
      reasoning: "No candidates were available to choose from.",
    };
  }

  const port = args.ai ?? productionAiSelectionPort;
  const shortlist = shown.map(spec.renderLine).join("\n");
  const result = await port.select({
    feature: spec.feature,
    rules: spec.rules,
    subject: args.subject,
    shortlist,
    usage: args.usage,
  });

  const selected =
    result.selectedId == null
      ? null
      : (shown.find(
          (candidate) =>
            normalizeId(spec.idOf(candidate)) ===
            normalizeId(result.selectedId!),
        ) ?? null);

  return {
    selected,
    confidence: result.confidence,
    reasoning: result.reasoning,
  };
}

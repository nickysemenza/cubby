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
 * - A roster the decision tier can take in one choice goes to Jev
 *   (`jev.ts`), which answers over positional `c0…cn` choices — the
 *   winner's index resolves straight back to the shown roster.
 * - A larger roster overflows to the fast chat tier
 *   ({@link SELECTION_OVERFLOW_FEATURE}): the model names the chosen
 *   candidate's id from a rendered shortlist, and an id it never saw
 *   resolves to null rather than to a guess.
 */
import type { AiSelectionResult, Confidence } from "@cubby/schemas/ai";

import {
  type AiDecisionFeature,
  SELECTION_OVERFLOW_FEATURE,
} from "~/server/ai/features";
import {
  JEV_MAX_CANDIDATES,
  type JevPort,
  runJevChoice,
} from "~/server/ai/jev";
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

/**
 * One consumer's declaration: which feature record it runs on, what it
 * selects over, how one candidate becomes a shortlist line, how to read a
 * candidate's stable id back out, its feature-specific prompt rules, and how
 * many candidates the model is ever shown.
 */
export interface AiSelectionSpec<C> {
  /** The `features.ts` record this selection runs as. */
  feature: AiDecisionFeature;
  /** The feature-specific prompt paragraph, sent alongside the shared frame. */
  rules: string;
  /** The stable id the overflow model is asked to echo back to name its
   * choice; the decision tier answers by index and never sees it. */
  idOf: (candidate: C) => string;
  /** One shortlist line for one candidate, in the spec's own format. */
  renderLine: (candidate: C) => string;
  /** Candidates beyond this many are never rendered or shown to the model. */
  maxCandidates: number;
}

/** The overflow call a spec's consumer fakes in tests instead of the network. */
export interface AiSelectionPort {
  select(args: {
    rules: string;
    subject: string;
    shortlist: string;
    usage: AiSelectionUsage;
  }): Promise<AiSelectionResult>;
}

const SELECTION_FRAME =
  "You are given a subject and a numbered shortlist. Choose exactly one entry's id, or null when none fits.";

const productionAiSelectionPort: AiSelectionPort = {
  select: async ({ rules, subject, shortlist, usage }) =>
    runStructuredFeature(
      SELECTION_OVERFLOW_FEATURE,
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
  /** Jev's calibrated probability, unavailable for overflow chat picks. */
  probability: number | null;
  /** Empty for a decision-tier pick, which writes no prose. */
  reasoning: string;
  /** Top-3 runners-up (after `selected`), from Jev's ranked distribution.
   * Always `[]` on the overflow/chat-tier path — a prose pick has no
   * distribution to rank — and when there were no candidates to choose from. */
  alternatives: { candidate: C; probability: number }[];
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
    jev?: JevPort;
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
      evaluated: false,
    };
  }

  if (shown.length > JEV_MAX_CANDIDATES) {
    const port = args.ai ?? productionAiSelectionPort;
    const result = await port.select({
      rules: spec.rules,
      subject: args.subject,
      shortlist: shown.map(spec.renderLine).join("\n"),
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
      evaluated: true,
    };
  }

  const result = await runJevChoice({
    feature: spec.feature,
    subject: args.subject,
    rules: spec.rules,
    choices: shown.map(spec.renderLine),
    usage: args.usage,
    port: args.jev,
  });
  const alternatives = result.ranked
    .filter((entry) => entry.index !== result.selectedIndex)
    .slice(0, 3)
    .flatMap((entry) => {
      const candidate = shown[entry.index];
      return candidate === undefined
        ? []
        : [{ candidate, probability: entry.probability }];
    });
  return {
    selected:
      result.selectedIndex === null
        ? null
        : (shown[result.selectedIndex] ?? null),
    confidence: result.confidence,
    probability: result.probability,
    reasoning: "",
    alternatives,
    evaluated: true,
  };
}

/**
 * The decision-tier request a closed-set choice sends, as pure data: the
 * Decisions catalog and the AI refresh manifest render it without the
 * transport in `decision-model.ts`.
 */
import { z } from "zod";

import type { AiDecisionFeature } from "./features";

export const NONE_KEY = "none";
export const MIB = 1024 * 1024;

/** Embedded-only Clef media. Dimensions, when known, are validated but not sent. */
const decisionImageSchema = z.union([
  z.string(),
  z.object({
    content_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
]);
export type DecisionImage = z.infer<typeof decisionImageSchema>;

function embeddedImages(images: readonly DecisionImage[]) {
  if (images.length > 4) throw new Error("Clef supports at most 4 images.");
  let totalBytes = 0;
  return images.map((value) => {
    const image = decisionImageSchema.parse(value);
    let base64: string;
    if (typeof image === "string") {
      const match = /^data:image\/(?:png|jpeg|webp);base64,(.*)$/i.exec(image);
      if (!match)
        throw new Error(
          "Clef images require embedded PNG, JPEG, or WebP data URLs.",
        );
      base64 = match[1]!;
    } else {
      base64 = image.base64;
      if ((image.width === undefined) !== (image.height === undefined)) {
        throw new Error("Clef image dimensions require both width and height.");
      }
      if (
        image.width !== undefined &&
        image.height !== undefined &&
        image.width * image.height > 16_000_000
      ) {
        throw new Error("Clef image exceeds 16 megapixels.");
      }
    }
    if (
      base64.length === 0 ||
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    ) {
      throw new Error("Clef image contains invalid base64.");
    }
    const bytes =
      (base64.length / 4) * 3 -
      (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    if (bytes > 4 * MIB) throw new Error("Clef image exceeds 4 MiB.");
    totalBytes += bytes;
    if (totalBytes > 8 * MIB)
      throw new Error("Clef images exceed 8 MiB total decoded bytes.");
    return typeof image === "string"
      ? image
      : { content_type: image.content_type, base64 };
  });
}

const decisionChoiceInputSchema = z.object({
  state: z.string(),
  images: z
    .array(
      z.union([
        z.string(),
        z.object({ content_type: z.string(), base64: z.string() }),
      ]),
    )
    .optional(),
  questions: z.object({
    selection: z.object({
      type: z.literal("choice"),
      instructions: z.string(),
      criteria: z.record(z.string(), z.string()),
    }),
  }),
});
export type DecisionChoiceInput = z.infer<typeof decisionChoiceInputSchema>;

export interface DecisionChoicePrompt {
  subject: string;
  rules: string;
  choices: readonly string[];
  allowNone?: boolean;
  images?: readonly DecisionImage[];
}

/** The exact request body a choice sends; the Decisions catalog renders it. */
export function buildChoiceInput(
  args: DecisionChoicePrompt,
): DecisionChoiceInput {
  const allowNone = args.allowNone ?? true;
  const criteria = Object.fromEntries(
    args.choices.map((label, index) => [`c${index}`, label]),
  );
  if (allowNone) criteria[NONE_KEY] = "No listed choice is a suitable match.";
  return {
    state: args.subject,
    ...(args.images?.length ? { images: embeddedImages(args.images) } : {}),
    questions: {
      selection: {
        type: "choice",
        instructions: allowNone
          ? `${args.rules}\nChoose exactly one option. Use none when no option fits.`
          : `${args.rules}\nChoose exactly one option.`,
        criteria,
      },
    },
  };
}

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

/** The roster choice a selection asks the decision tier; the Decisions
 * catalog renders the same prompt. */
export function selectionPrompt<C>(
  spec: Pick<AiSelectionSpec<C>, "rules" | "renderLine">,
  subject: string,
  shown: readonly C[],
): DecisionChoicePrompt & { choices: string[] } {
  return { subject, rules: spec.rules, choices: shown.map(spec.renderLine) };
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

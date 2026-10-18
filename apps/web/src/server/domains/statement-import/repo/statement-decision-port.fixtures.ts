import type { DecisionPort } from "~/server/ai/decision-model";

/** Answers each statement decision by its choice label, at a stated confidence. */
export const answering =
  (answers: {
    kind?: string | ((subject: string) => string);
    counterparty?: string;
    kindConfidence?: number;
  }): DecisionPort =>
  async (input) => {
    const criteria = input.questions.selection.criteria;
    const labels = Object.values(criteria);
    const [wanted, confidence] = labels.includes("same_charge")
      ? ["same_charge", 0.97]
      : labels.includes("person")
        ? [answers.counterparty ?? "insufficient_evidence", 0.97]
        : [
            typeof answers.kind === "function"
              ? answers.kind(input.state)
              : (answers.kind ?? "other"),
            answers.kindConfidence ?? 0.97,
          ];
    const keys = Object.keys(criteria);
    const choice = keys.find((key) => criteria[key] === wanted)!;
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice
                ? confidence
                : (1 - confidence) / (keys.length - 1),
            ]),
          ),
        },
      },
    };
  };

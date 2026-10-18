import { describe, expect, it } from "vitest";

import { DecisionRequestBatch } from "./decision-request-batch";

const question = (state: string) => ({
  state,
  questions: {
    selection: {
      type: "choice" as const,
      instructions: "Choose one.",
      criteria: { c0: "one" },
    },
  },
});

describe("DecisionRequestBatch", () => {
  // The shared call is counted once, but a later cache hit for one question
  // avoids only that question's share of it.
  it("counts shared usage once and gives every question an even share", async () => {
    const batch = new DecisionRequestBatch(2);
    const execute = async () => ({
      answers: Object.fromEntries(
        ["q0", "q1"].map((id) => [
          id,
          {
            type: "choice" as const,
            choice: "c0",
            confidence: 1,
            probabilities: { c0: 1 },
          },
        ]),
      ),
      usage: { input_tokens: 301, output_tokens: 40 },
    });
    const [first, second] = await Promise.all([
      batch.request(0, "group", question("left"), execute),
      batch.request(1, "group", question("right"), execute),
    ]);
    expect(first?.usage).toEqual({ input_tokens: 301, output_tokens: 40 });
    expect(second?.usage).toBeUndefined();
    for (const response of [first, second])
      expect(response?.questionUsage).toEqual({
        input_tokens: 151,
        output_tokens: 20,
      });
  });
});

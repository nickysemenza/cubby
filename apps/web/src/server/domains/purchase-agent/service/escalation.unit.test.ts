// Guard the per-Email question budget: one answer per ladder model, kept across
// re-claims of the same Email, refused for non-reasoning blockers and unfunded
// escalation.
import type { SupportedChatModel } from "@cubby/shared/ai/models";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { coordinatorEscalation } from "./escalation";

function harness(unavailable?: () => Promise<string | null>) {
  const state = new Map<string, string>();
  const asked: SupportedChatModel[] = [];
  const escalation = coordinatorEscalation({
    models: { primary: "gpt-6-luna", escalation: "gpt-6.1-terra" },
    store: {
      read: (key) => state.get(key),
      write: (key, value) => {
        state.set(key, value);
      },
    },
    ladder: ["gpt-6.1-terra", "gpt-6.1-sol"],
    ask: async (model) => {
      asked.push(model);
      return { text: `answer from ${model}` };
    },
    unavailable,
  });
  const claim = (messageId: string) => {
    const result: ToolExecutionResult = {
      output: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "email",
            email: { mailboxId: "synthetic-mailbox", messageId },
          }),
        },
      ],
      isError: false,
    };
    escalation.afterTool(
      {
        id: `claim-${messageId}`,
        name: "claim_next_import_work",
        arguments: {},
      },
      result,
    );
  };
  return { escalation, asked, claim };
}

const question = {
  category: "extraction" as const,
  reason: "Two totals are printed",
  question: "Which printed amount is the order total?",
};

describe("coordinator escalation", () => {
  it("answers each Email once per ladder model and keeps the budget across re-claims", async () => {
    const { escalation, asked, claim } = harness();
    claim("synthetic-1");
    expect(await escalation.escalate(question)).toEqual({
      answered: true,
      model: "gpt-6.1-terra",
      answer: "answer from gpt-6.1-terra",
    });
    claim("synthetic-1");
    expect(await escalation.escalate(question)).toMatchObject({
      answered: true,
      model: "gpt-6.1-sol",
    });
    expect(await escalation.escalate(question)).toMatchObject({
      answered: false,
    });
    expect(escalation.escalated()).toBe(true);
    claim("synthetic-2");
    expect(escalation.escalated()).toBe(false);
    expect(await escalation.escalate(question)).toMatchObject({
      model: "gpt-6.1-terra",
    });
    expect(asked).toEqual(["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.1-terra"]);
  });

  it("refuses non-reasoning blockers and unfunded escalation without asking", async () => {
    const funded = harness();
    funded.claim("synthetic-1");
    expect(
      await funded.escalation.escalate({
        ...question,
        category: "missing_evidence",
      }),
    ).toMatchObject({ answered: false });
    const unfunded = harness(async () => "No free source can fund it");
    unfunded.claim("synthetic-1");
    expect(await unfunded.escalation.escalate(question)).toEqual({
      answered: false,
      model: "gpt-6.1-terra",
      unavailable: "No free source can fund it",
    });
    expect([...funded.asked, ...unfunded.asked]).toEqual([]);
  });
});

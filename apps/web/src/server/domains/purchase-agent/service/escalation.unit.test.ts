// Guard the per-Email question budget: one answer per ladder model, kept across
// re-claims of the same Email and across a recovered call, refused for
// non-reasoning blockers and unfunded escalation, and a conversation an
// earlier coordinator switched to its escalation model returns to the primary.
import type { SupportedChatModel } from "@cubby/shared/ai/models";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { coordinatorEscalation } from "./escalation";

function harness(unavailable?: () => Promise<string | null>) {
  const state = new Map<string, string>();
  const asked: SupportedChatModel[] = [];
  const configured: SupportedChatModel[] = [];
  const escalation = coordinatorEscalation({
    models: { primary: "gpt-6-luna", escalation: "gpt-6.1-terra" },
    store: {
      read: (key) => state.get(key),
      write: (key, value) => {
        state.set(key, value);
      },
    },
    ladder: ["gpt-6.1-terra", "gpt-6.1-sol"],
    useModel: async (model) => {
      configured.push(model);
    },
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
    return escalation.afterTool(
      {
        id: `claim-${messageId}`,
        name: "claim_next_import_work",
        arguments: {},
      },
      result,
    );
  };
  return { escalation, asked, configured, claim, state };
}

const question = {
  category: "extraction" as const,
  reason: "Two totals are printed",
  question: "Which printed amount is the order total?",
};

describe("coordinator escalation", () => {
  it("answers each Email once per ladder model, keeps the budget across re-claims and replays a recovered call", async () => {
    const { escalation, asked, claim } = harness();
    await claim("synthetic-1");
    expect(await escalation.escalate(question, "call-1")).toEqual({
      answered: true,
      model: "gpt-6.1-terra",
      answer: "answer from gpt-6.1-terra",
    });
    // A recovered call returns its recorded answer without new inference.
    expect(await escalation.escalate(question, "call-1")).toMatchObject({
      model: "gpt-6.1-terra",
    });
    await claim("synthetic-1");
    expect(await escalation.escalate(question, "call-2")).toMatchObject({
      answered: true,
      model: "gpt-6.1-sol",
    });
    expect(await escalation.escalate(question, "call-3")).toMatchObject({
      answered: false,
    });
    expect(escalation.escalated()).toBe(true);
    await claim("synthetic-2");
    expect(escalation.escalated()).toBe(false);
    expect(await escalation.escalate(question, "call-4")).toMatchObject({
      model: "gpt-6.1-terra",
    });
    expect(asked).toEqual(["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.1-terra"]);
  });

  it("refuses non-reasoning blockers and unfunded escalation without asking", async () => {
    const funded = harness();
    await funded.claim("synthetic-1");
    expect(
      await funded.escalation.escalate(
        { ...question, category: "missing_evidence" },
        "call-1",
      ),
    ).toMatchObject({ answered: false });
    const unfunded = harness(async () => "No free source can fund it");
    await unfunded.claim("synthetic-1");
    expect(await unfunded.escalation.escalate(question, "call-1")).toEqual({
      answered: false,
      model: "gpt-6.1-terra",
      unavailable: "No free source can fund it",
    });
    expect([...funded.asked, ...unfunded.asked]).toEqual([]);
  });

  it("returns a conversation left on the escalation model to the primary at the next claim", async () => {
    const { configured, claim, state } = harness();
    state.set(
      "escalation:model-configuration",
      JSON.stringify({ model: "gpt-6.1-terra", status: "applied" }),
    );
    await claim("synthetic-1");
    await claim("synthetic-2");
    expect(configured).toEqual(["gpt-6-luna"]);
  });
});

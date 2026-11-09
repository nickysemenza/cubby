// Guard model-configuration recovery, escalation leaking to the next Email,
// same-Email re-claim loops, unavailable funding and equal-model no-ops.
import type { SupportedChatModel } from "@cubby/shared/ai/models";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { coordinatorEscalation } from "./escalation";

function harness(
  models: { primary: SupportedChatModel; escalation?: SupportedChatModel } = {
    primary: "claude-haiku-5-5",
    escalation: "claude-opus-5-5",
  },
  configure?: (model: SupportedChatModel) => Promise<void>,
  unavailable?: (model: SupportedChatModel) => Promise<string | null>,
  fundedAlternative?: SupportedChatModel,
) {
  const state = new Map<string, string>();
  const configured: SupportedChatModel[] = [];
  const escalation = coordinatorEscalation({
    models,
    fundedAlternative,
    store: {
      read: (key) => state.get(key),
      write: (key, value) => {
        state.set(key, value);
      },
    },
    useModel: async (model) => {
      configured.push(model);
      await configure?.(model);
    },
    unavailable,
  });
  const ok: ToolExecutionResult = {
    output: [{ type: "text", text: "{}" }],
    isError: false,
  };
  const claim = (id: string, messageId?: string) =>
    escalation.afterTool(
      { id, name: "claim_next_import_work", arguments: {} },
      messageId
        ? {
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
          }
        : ok,
    );
  return { escalation, configured, claim, state };
}

describe("coordinator escalation", () => {
  it.each([true, false])(
    "selects Sol before transmission only when its free funding is available=%s",
    async (available) => {
      const models = {
        primary: "gpt-6-luna",
        escalation: "claude-opus-5-5",
      } as const;
      const { escalation, configured, claim, state } = harness(
        models,
        undefined,
        async (model) =>
          model === "gpt-6.1-sol" && available
            ? null
            : "Synthetic credit unavailable",
        "gpt-6.1-sol",
      );
      await claim("claim", "synthetic-order");
      expect(
        await escalation.escalate({
          category: "identity",
          reason: "Synthetic variant ambiguity",
        }),
      ).toMatchObject({
        escalated: available,
        model: available ? "gpt-6.1-sol" : "gpt-6-luna",
      });
      expect(configured).toEqual(available ? ["gpt-6.1-sol"] : []);
      const recovered = coordinatorEscalation({
        models,
        store: {
          read: (key) => state.get(key),
          write: (key, value) => state.set(key, value),
        },
        useModel: async () => {},
      });
      expect(recovered.model()).toBe(available ? "gpt-6.1-sol" : "gpt-6-luna");
    },
  );
  it.each([
    "missing_evidence",
    "member_decision",
    "source_held",
    "transient_failure",
  ] as const)("does not spend escalation on %s", async (category) => {
    const { escalation, configured, claim } = harness();
    await claim("claim-1", "synthetic-a");
    expect(
      await escalation.escalate({ category, reason: "Synthetic blocker" }),
    ).toMatchObject({ escalated: false, model: "claude-haiku-5-5" });
    expect(configured).toEqual([]);
  });

  // Configuration can fail after the durable decision or after its own effect.
  // Replaying that same transition must reconcile before it returns success.
  it("reconciles failed explicit escalation on recovery", async () => {
    let refuse = true;
    const { escalation, configured, claim } = harness(
      undefined,
      async (model) => {
        if (model === "claude-opus-5-5" && refuse) {
          refuse = false;
          throw new Error("Synthetic configure interruption");
        }
      },
    );
    await claim("claim-1");
    const transition = () =>
      escalation.escalate({
        category: "contradiction",
        reason: "Synthetic ambiguity",
      });
    await expect(transition()).rejects.toThrow(
      "Synthetic configure interruption",
    );
    const attempts = configured.length;
    await transition();
    expect(configured.slice(attempts)).toEqual(["claude-opus-5-5"]);
  });

  it("reconciles an interrupted next-claim reset before accepting the replay", async () => {
    let refuse = false;
    const { escalation, configured, claim } = harness(
      undefined,
      async (model) => {
        if (model === "claude-haiku-5-5" && refuse) {
          refuse = false;
          throw new Error("Synthetic reset interruption");
        }
      },
    );
    await claim("claim-1");
    await escalation.escalate({
      category: "identity",
      reason: "Synthetic ambiguity",
    });
    refuse = true;
    await expect(claim("claim-2")).rejects.toThrow(
      "Synthetic reset interruption",
    );
    const attempts = configured.length;
    await claim("claim-2");
    expect(configured.slice(attempts)).toEqual(["claude-haiku-5-5"]);
  });

  it("escalates the current Email on request and returns to the primary at the next claim", async () => {
    const { escalation, configured, claim } = harness();
    expect(escalation.active).toBe(true);
    await claim("claim-1");
    expect(escalation.model()).toBe("claude-haiku-5-5");
    expect(
      await escalation.escalate({ category: "identity", reason: "Unclear" }),
    ).toEqual({ escalated: true, model: "claude-opus-5-5" });
    expect(escalation.model()).toBe("claude-opus-5-5");
    // A second request on the same Email changes nothing.
    expect(
      await escalation.escalate({ category: "identity", reason: "Again" }),
    ).toEqual({ escalated: false, model: "claude-opus-5-5" });
    await claim("claim-2");
    expect(escalation.model()).toBe("claude-haiku-5-5");
    expect(configured).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });

  // Regression (2026-10-19): the escalation model re-claimed its unsettled
  // Email, the claim reset it to the primary, and the primary escalated again.
  it("keeps an Email escalated when a claim returns it again", async () => {
    const { escalation, configured, claim } = harness();
    await claim("claim-1", "synthetic-a");
    await escalation.escalate({ category: "identity", reason: "Unclear" });
    await claim("claim-2", "synthetic-a");
    expect(escalation.model()).toBe("claude-opus-5-5");
    await claim("claim-3", "synthetic-b");
    expect(escalation.model()).toBe("claude-haiku-5-5");
    expect(configured).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });

  it("lets the primary settle an Email whose escalation model cannot be funded", async () => {
    let reason: string | null = "Synthetic credit refusal";
    let asked = 0;
    const { escalation, configured, claim } = harness(
      undefined,
      undefined,
      async () => {
        asked += 1;
        return reason;
      },
    );
    await claim("claim-1", "synthetic-a");
    expect(
      await escalation.escalate({ category: "identity", reason: "Unclear" }),
    ).toEqual({
      escalated: false,
      model: "claude-haiku-5-5",
      unavailable: "Synthetic credit refusal",
    });
    // Decided once per Email: a recovered call decides as it first did.
    reason = null;
    await escalation.escalate({
      category: "identity",
      reason: "Synthetic ambiguity",
    });
    expect(asked).toBe(1);
    expect(configured).toEqual([]);
    // The next Email asks again.
    await claim("claim-2", "synthetic-b");
    expect(
      (
        await escalation.escalate({
          category: "identity",
          reason: "Synthetic ambiguity",
        })
      ).model,
    ).toBe("claude-opus-5-5");
  });

  it.each([
    { primary: "claude-opus-5-5", escalation: "claude-opus-5-5" },
    { primary: "claude-opus-5-5" },
  ] as const)("is inert when %o", async (models) => {
    const { escalation, configured, claim } = harness(models);
    expect(escalation.active).toBe(false);
    await claim("claim-1");
    expect(
      await escalation.escalate({ category: "identity", reason: "Unclear" }),
    ).toEqual({ escalated: false, model: "claude-opus-5-5" });
    expect(configured).toEqual([]);
  });
});

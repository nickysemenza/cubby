/**
 * Failures: a cheaper primary records an Email `unresolved` without the
 * escalation model ever trying it; two refused prepares keep looping on the
 * primary; one refusal on each of two Emails escalates the second; an
 * escalation leaks into the next Email; a recovered (replayed) tool call
 * decides differently from its first run; a primary equal to its
 * escalation model changes anything at all; re-claiming the same unsettled
 * Email resets it to the primary, which escalates it again in a loop; and an
 * escalation whose model cannot be funded falls through to another model;
 * and a prepare refused because another Run holds its supporting original
 * escalates, though the stronger model meets the same refusal.
 */
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
  unavailable?: () => Promise<string | null>,
) {
  const state = new Map<string, string>();
  const configured: SupportedChatModel[] = [];
  const escalation = coordinatorEscalation({
    models,
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
  const refused: ToolExecutionResult = {
    output: [{ type: "text", text: "Order lines do not sum to the total." }],
    isError: true,
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
  const prepare = (id: string, result = refused) =>
    escalation.afterTool(
      {
        id,
        name: "mcp__cubby__purchase_import",
        arguments: { action: "prepare", orders: [] },
      },
      result,
    );
  const resolve = (id: string, kind: string) =>
    escalation.beforeTool({
      id,
      name: "mcp__cubby__purchase_import",
      arguments: {
        action: "mail_resolve",
        input: { disposition: { kind, reason: "Synthetic missing total." } },
      },
    });
  return { escalation, configured, claim, prepare, resolve };
}

describe("coordinator escalation", () => {
  // Configuration can fail after the durable decision or after its own effect.
  // Replaying that same transition must reconcile before it returns success.
  it.each(["requested", "prepare", "unresolved"] as const)(
    "reconciles failed %s escalation on the same call",
    async (trigger) => {
      let refuse = true;
      const { escalation, configured, claim, prepare, resolve } = harness(
        undefined,
        async (model) => {
          if (model === "claude-opus-5-5" && refuse) {
            refuse = false;
            throw new Error("Synthetic configure interruption");
          }
        },
      );
      await claim("claim-1");
      if (trigger === "prepare") await prepare("prepare-1");
      const transition = () =>
        trigger === "requested"
          ? escalation.escalate({
              reason: "requested",
              detail: "Synthetic ambiguity",
            })
          : trigger === "prepare"
            ? prepare("prepare-2")
            : resolve("resolve-1", "unresolved");
      await expect(transition()).rejects.toThrow(
        "Synthetic configure interruption",
      );
      const attempts = configured.length;
      await transition();
      expect(configured.slice(attempts)).toEqual(["claude-opus-5-5"]);
    },
  );

  // Pi can turn a failed beforeTool hook into a tool error. The primary's
  // next unresolved call then has a new ID and still needs a stronger turn.
  it("holds a new primary-authored resolution after recovering failed configuration", async () => {
    let fail = true;
    const { configured, claim, resolve } = harness(undefined, async (model) => {
      if (model === "claude-opus-5-5" && fail) {
        fail = false;
        throw new Error("Synthetic failure before model configuration");
      }
    });
    await claim("claim-1");
    await expect(resolve("resolve-primary-1", "unresolved")).rejects.toThrow(
      "Synthetic failure before model configuration",
    );
    const recovered = await resolve("resolve-primary-2", "unresolved");
    expect(recovered?.block).toContain("claude-opus-5-5");
    expect(configured).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(await resolve("resolve-primary-2", "unresolved")).toEqual(recovered);
    expect(await resolve("resolve-escalated", "unresolved")).toBeUndefined();
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
      reason: "requested",
      detail: "Synthetic ambiguity",
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
      await escalation.escalate({ reason: "requested", detail: "Unclear" }),
    ).toEqual({ escalated: true, model: "claude-opus-5-5" });
    expect(escalation.model()).toBe("claude-opus-5-5");
    // A second request on the same Email changes nothing.
    expect(
      await escalation.escalate({ reason: "requested", detail: "Again" }),
    ).toEqual({ escalated: false, model: "claude-opus-5-5" });
    await claim("claim-2");
    expect(escalation.model()).toBe("claude-haiku-5-5");
    expect(configured).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });

  it("escalates after the second refused prepare of one Email, not one on each of two", async () => {
    const { configured, claim, prepare } = harness();
    await claim("claim-1");
    expect(await prepare("prepare-1")).toBeUndefined();
    await claim("claim-2");
    expect(await prepare("prepare-2")).toBeUndefined();
    // A recovered tool call re-runs afterTool; it is still one refusal.
    expect(await prepare("prepare-2")).toBeUndefined();
    expect(configured).toEqual([]);
    const second = await prepare("prepare-3");
    expect(configured).toEqual(["claude-opus-5-5"]);
    expect(JSON.stringify(second?.output)).toContain("claude-opus-5-5");
    expect(second?.isError).toBe(true);
    // A replay of the escalating call keeps its note.
    expect(JSON.stringify((await prepare("prepare-3"))?.output)).toContain(
      "claude-opus-5-5",
    );
    expect(await prepare("prepare-4", { output: [], isError: false })).toBe(
      undefined,
    );
  });

  it("does not escalate prepares refused because another Run holds the source", async () => {
    const { configured, claim, prepare } = harness();
    const held: ToolExecutionResult = {
      output: [
        {
          type: "text",
          text: "CONFLICT: Another Mail import Run holds EML-2222 (RUN-2222, paused_auth). (MAIL_SOURCE_HELD_BY_RUN)",
        },
      ],
      isError: true,
    };
    await claim("claim-1");
    expect(await prepare("prepare-1", held)).toBeUndefined();
    expect(await prepare("prepare-2", held)).toBeUndefined();
    expect(await prepare("prepare-3")).toBeUndefined();
    expect(configured).toEqual([]);
  });

  it("gives the escalation model one try before an Email is resolved unresolved", async () => {
    const { escalation, configured, claim, resolve } = harness();
    await claim("claim-1");
    expect(await resolve("resolve-linked", "linked")).toBeUndefined();
    const blocked = await resolve("resolve-1", "unresolved");
    expect(blocked?.block).toContain("claude-opus-5-5");
    expect(configured).toEqual(["claude-opus-5-5"]);
    // Recovery of the blocked call blocks again rather than running it.
    expect(await resolve("resolve-1", "unresolved")).toEqual(blocked);
    // The escalation model's own unresolved resolution is recorded.
    expect(await resolve("resolve-2", "unresolved")).toBeUndefined();
    expect(escalation.model()).toBe("claude-opus-5-5");
  });

  // Regression (2026-10-19): the escalation model re-claimed its unsettled
  // Email, the claim reset it to the primary, and the primary escalated again.
  it("keeps an Email escalated when a claim returns it again", async () => {
    const { escalation, configured, claim, resolve } = harness();
    await claim("claim-1", "synthetic-a");
    await escalation.escalate({ reason: "requested", detail: "Unclear" });
    await claim("claim-2", "synthetic-a");
    expect(escalation.model()).toBe("claude-opus-5-5");
    expect(await resolve("resolve-1", "unresolved")).toBeUndefined();
    await claim("claim-3", "synthetic-b");
    expect(escalation.model()).toBe("claude-haiku-5-5");
    expect(configured).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });

  it("lets the primary settle an Email whose escalation model cannot be funded", async () => {
    let reason: string | null = "Synthetic credit refusal";
    let asked = 0;
    const { escalation, configured, claim, prepare, resolve } = harness(
      undefined,
      undefined,
      async () => {
        asked += 1;
        return reason;
      },
    );
    await claim("claim-1", "synthetic-a");
    expect(
      await escalation.escalate({ reason: "requested", detail: "Unclear" }),
    ).toEqual({
      escalated: false,
      model: "claude-haiku-5-5",
      unavailable: "Synthetic credit refusal",
    });
    await prepare("prepare-1");
    expect(await prepare("prepare-2")).toBeUndefined();
    expect(await resolve("resolve-1", "unresolved")).toBeUndefined();
    // Decided once per Email: a recovered call decides as it first did.
    reason = null;
    expect(await resolve("resolve-1", "unresolved")).toBeUndefined();
    expect(asked).toBe(1);
    expect(configured).toEqual([]);
    // The next Email asks again.
    await claim("claim-2", "synthetic-b");
    expect((await resolve("resolve-2", "unresolved"))?.block).toContain(
      "claude-opus-5-5",
    );
  });

  it.each([
    { primary: "claude-opus-5-5", escalation: "claude-opus-5-5" },
    { primary: "claude-opus-5-5" },
  ] as const)("is inert when %o", async (models) => {
    const { escalation, configured, claim, prepare, resolve } = harness(models);
    expect(escalation.active).toBe(false);
    await claim("claim-1");
    await prepare("prepare-1");
    await prepare("prepare-2");
    expect(await resolve("resolve-1", "unresolved")).toBeUndefined();
    expect(
      await escalation.escalate({ reason: "requested", detail: "Unclear" }),
    ).toEqual({ escalated: false, model: "claude-opus-5-5" });
    expect(configured).toEqual([]);
  });
});

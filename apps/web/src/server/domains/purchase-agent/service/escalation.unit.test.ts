/**
 * Failures: a cheaper primary records an Email `unresolved` without the
 * escalation model ever trying it; two refused prepares keep looping on the
 * primary; one refusal on each of two Emails escalates the second; an
 * escalation leaks into the next Email; a recovered (replayed) tool call
 * decides differently from its first run; and a primary equal to its
 * escalation model changes anything at all.
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
  });
  const ok: ToolExecutionResult = {
    output: [{ type: "text", text: "{}" }],
    isError: false,
  };
  const refused: ToolExecutionResult = {
    output: [{ type: "text", text: "Order lines do not sum to the total." }],
    isError: true,
  };
  const claim = (id: string) =>
    escalation.afterTool(
      { id, name: "claim_next_import_work", arguments: {} },
      ok,
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
      name: "mcp__cubby__mail",
      arguments: {
        action: "resolve",
        disposition: { kind, reason: "Synthetic missing total." },
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

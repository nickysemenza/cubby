import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { ToolTask, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import type { RunServices } from "./environment";
import { continueMailImportOnYield, runAgentTools } from "./tools";

function fakeApi(): ToolExecutionApi {
  const memos = new Map<string, unknown>();
  return fromPartial<ToolExecutionApi>({
    taskId: fromAny(1),
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return fromAny(memos.get(name));
    },
  });
}
const tools = (services: RunServices) =>
  runAgentTools(
    () => services,
    async () => ({ generation: "synthetic-generation", sequence: 1 }),
  );
describe("run agent tool behavior", () => {
  it("continues a premature Mail answer with the next durable claim and preserves replay", async () => {
    let claims = 0;
    const services: Pick<RunServices, "claimNextWork" | "loadScope"> = {
      loadScope: async () => ({
        purpose: "mail_import",
        agentId: "synthetic-agent",
        generation: "synthetic-generation",
      }),
      claimNextWork: async () => {
        claims++;
        return {
          kind: "email",
          email: {
            mailboxId: "synthetic-mailbox",
            messageId: "synthetic-return",
          },
        };
      },
    };
    const api = fakeApi();
    const first = await continueMailImportOnYield({
      services,
      api,
      context: BACKGROUND_CONTEXT,
      generation: "synthetic-generation",
    });
    expect(first?.continue).toContain("synthetic-return");
    expect(first?.continue).toContain("resolve this Email unresolved");
    expect(
      await continueMailImportOnYield({
        services,
        api,
        context: BACKGROUND_CONTEXT,
        generation: "synthetic-generation",
      }),
    ).toEqual(first);
    expect(claims).toBe(1);
  });

  it.each(["none", "stopped"])(
    "allows settlement when the claim returns %s",
    async (kind) => {
      expect(
        await continueMailImportOnYield({
          services: {
            loadScope: async () => ({
              purpose: "mail_import",
              agentId: "synthetic-agent",
              generation: "synthetic-generation",
            }),
            claimNextWork: async () => ({ kind }),
          },
          api: fakeApi(),
          context: BACKGROUND_CONTEXT,
          generation: "synthetic-generation",
        }),
      ).toBeUndefined();
    },
  );

  it("does not claim work from a superseded generation", async () => {
    let claims = 0;
    const result = await continueMailImportOnYield({
      services: {
        loadScope: async () => ({
          purpose: "mail_import",
          agentId: "synthetic-agent",
          generation: "replacement-generation",
        }),
        claimNextWork: async () => {
          claims++;
          return { kind: "email" };
        },
      },
      api: fakeApi(),
      context: BACKGROUND_CONTEXT,
      generation: "old-generation",
    });
    expect(result).toBeUndefined();
    expect(claims).toBe(0);
  });

  it("preserves a live v1 tool call's identity and replay checkpoint", () => {
    const input = { assistant: 1, callId: "synthetic-call" };
    const checkpoint = {
      phase: "execute",
      arguments: { quantity: 2 },
      replay: "safe",
    };
    expect(ToolTask.definition.migrate?.(input, checkpoint, 1)).toEqual({
      input: { kind: "model", ...input },
      checkpoint,
    });
    expect(input).toEqual({ assistant: 1, callId: "synthetic-call" });
  });

  it("ends the submission when a claim finds the run already stopped", async () => {
    const tool = tools(
      fromPartial<RunServices>({
        claimNextWork: async () => ({
          kind: "stopped",
          status: "needs_review",
        }),
      }),
    ).find((candidate) => candidate.name === "claim_next_import_work");
    if (!tool) throw new Error("Missing photo work claim");
    const result = await tool.execute({}, fakeApi(), BACKGROUND_CONTEXT);
    expect(result.control?.terminate).toBe(true);
    expect(result.output).toEqual([
      {
        type: "text",
        text: JSON.stringify({ kind: "stopped", status: "needs_review" }),
      },
    ]);
  });
  it("converts loosely typed scalars as TypeBox always has", () => {
    const tool = tools(fromPartial<RunServices>({})).find(
      (candidate) => candidate.name === "report_agent_progress",
    );
    if (!tool) throw new Error("Missing photo progress tool");
    const cases: Array<[string | number, boolean]> = [
      ["TRUE", true],
      ["False", false],
      ["1", true],
      ["0", false],
      [1, true],
      [0, false],
    ];
    for (const [sent, expected] of cases) {
      const args = validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: tool.name,
        arguments: {
          operationId: "op-1",
          phase: "review",
          awaitingApproval: sent,
        },
      });
      expect(args.awaitingApproval).toBe(expected);
    }
  });
});

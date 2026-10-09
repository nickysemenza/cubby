import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import type { RunServices } from "./environment";
import { photoInventoryTools } from "./tools";

function fakeApi(): ToolExecutionApi {
  const memos = new Map<string, unknown>();
  return fromPartial<ToolExecutionApi>({
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return fromAny(memos.get(name));
    },
  });
}
const tools = (services: RunServices) => photoInventoryTools(() => services);
describe("photo inventory retained tool behavior", () => {
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
    expect(
      (
        await tool.execute(
          { operationId: "op-1" },
          fakeApi(),
          BACKGROUND_CONTEXT,
        )
      ).control?.terminate,
    ).toBe(true);
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

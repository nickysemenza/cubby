import { DatabaseSync } from "node:sqlite";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RunServices } from "./environment";
import { recordResearchToolOutcome } from "./research-failure-bound";
import { photoInventoryTools, purchaseImportTools } from "./tools";

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

// Returned browser failures must not reset the durable bound; replay must not
// count twice, and member/browser waits must remain recoverable.
describe("returned browser failure admission", () => {
  it("stops distinct unchanged blocked calls through persisted tool outcomes, not one replay", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const write = db.prepare(
      "INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    const read = db.prepare("SELECT value FROM state WHERE key=?");
    const store = {
      read: (key: string) => {
        return z.string().optional().parse(read.get(key)?.value);
      },
      write: (key: string, value: string) => {
        write.run(key, value);
      },
      atomic: (effect: () => string | undefined) => {
        db.exec("BEGIN");
        try {
          const value = effect();
          db.exec("COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
    try {
      let status = "waiting";
      const tool = purchaseImportTools(
        () =>
          fromPartial<RunServices>({
            researchObserve: async () => ({
              status,
              reason: "capture_failed",
              diagnostic: "Synthetic capture failed",
              workRef: "00000000-0000-4000-8000-000000000001",
            }),
          }),
        undefined,
        undefined,
        (name, args, callId, error) =>
          recordResearchToolOutcome(store, name, args, callId, error),
      ).find((candidate) => candidate.name === "work_observe");
      if (!tool) throw new Error("Missing browser observation tool");
      const args = {
        workRef: "00000000-0000-4000-8000-000000000001",
        action: { kind: "read" },
      };
      for (let index = 0; index < 3; index++) {
        const waiting = await tool.execute(args, fakeApi(), BACKGROUND_CONTEXT);
        expect(waiting.isError).not.toBe(true);
        expect(waiting.control?.terminate).toBe(true);
      }
      status = "blocked";
      const first = fakeApi();
      expect(
        (await tool.execute(args, first, BACKGROUND_CONTEXT)).isError,
      ).not.toBe(true);
      expect(
        (await tool.execute(args, first, BACKGROUND_CONTEXT)).isError,
      ).not.toBe(true);
      expect(
        (await tool.execute(args, fakeApi(), BACKGROUND_CONTEXT)).isError,
      ).not.toBe(true);
      const third = await tool.execute(args, fakeApi(), BACKGROUND_CONTEXT);
      expect(third.isError).toBe(true);
      expect(JSON.stringify(third)).toContain("Synthetic capture failed");
    } finally {
      db.close();
    }
  });
});

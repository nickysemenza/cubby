import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import type { PurchaseImportService } from "./service";
import { purchaseImportTools } from "./tools";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const unusedService = () => {
  throw new Error("tools only call their service when pi invokes them");
};

/** The memo surface `step` uses: a per-task key/value store. */
function fakeApi(): ToolExecutionApi {
  const memos = new Map<string, unknown>();
  // `memo(name, context)` reads; `memo(name, candidate, context)` keeps the
  // first candidate and returns whichever value was stored. Tools reach only
  // `memo` on the execution API.
  return fromPartial<ToolExecutionApi>({
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return fromAny(memos.get(name));
    },
  });
}

const toolNamed = (
  name: string,
  service: () => PurchaseImportService = unusedService,
) => {
  const tool = purchaseImportTools(runId, service).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
};

describe("purchase-import agent tool authority", () => {
  it("keeps model-facing RPC limited to bounded browser and run lifecycle operations", () => {
    const tools = purchaseImportTools(runId, unusedService);
    expect(tools.map((tool) => tool.name)).toEqual([
      "claim_next_import_work",
      "extract_receipt_evidence",
      "extract_run_evidence",
      "issue_browser_command",
      "read_browser_command_result",
      "import_browser_order_evidence",
      "report_agent_progress",
      "save_navigation_hints",
      "mark_history_expired",
      "finish_import_run",
      "stop_import_run_for_review",
      "defer_order_for_review",
      "settle_charge_hunt",
    ]);
    expect(tools.every((tool) => tool.replay === "safe")).toBe(true);
  });

  // A pending browser command must end the run so the queue event can resume
  // it, rather than leaving the coordinator polling.
  it("ends the run on a pending browser command and replays its effect once", async () => {
    const issueBrowserCommand = vi.fn(async () => ({ state: "dispatched" }));
    // The browser tool calls only these two service methods.
    const service = () =>
      fromPartial<PurchaseImportService>({
        updateAgentProgress: async () => ({ recorded: true }),
        issueBrowserCommand,
      });
    const tool = toolNamed("issue_browser_command", service);
    const api = fakeApi();
    const args = {
      operationId: "browse-1",
      command: { kind: "capture_order" as const, target: "order-1" },
    };

    const first = await tool.execute(args, api, BACKGROUND_CONTEXT);
    const replay = await tool.execute(args, api, BACKGROUND_CONTEXT);

    expect(first.control).toEqual({ terminate: true });
    expect(replay).toEqual(first);
    expect(issueBrowserCommand).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary browser actions and unbounded progress text", () => {
    const call = (name: string, args: JsonObject) => () =>
      validateToolArguments(toolNamed(name), {
        type: "toolCall",
        id: "call-1",
        name,
        arguments: args,
      });

    expect(
      call("issue_browser_command", {
        operationId: "auth-without-evidence",
        command: { kind: "open_auth" },
      }),
    ).toThrow(/command/);
    expect(
      call("report_agent_progress", {
        operationId: "progress-1",
        phase: "awaiting_approval",
        awaitingApproval: true,
        detail: "x".repeat(1_001),
      }),
    ).toThrow(/detail/);
  });
});

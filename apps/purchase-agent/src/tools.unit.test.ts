import { describe, expect, it } from "vitest";
import * as v from "valibot";

import { purchaseImportTools, shouldSettleForBrowserResult } from "./tools";

const unusedService = () => {
  throw new Error("tools only call their service when Flue invokes them");
};

describe("purchase-import agent tool authority", () => {
  it("keeps model-facing RPC limited to bounded browser and run lifecycle operations", () => {
    const tools = purchaseImportTools(
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      unusedService,
    );

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
    ]);
    expect(
      tools
        .filter((tool) => tool.name !== "read_browser_command_result")
        .every((tool) => tool.durable),
    ).toBe(true);
  });

  it("settles rather than polling unavailable browser work", () => {
    expect(shouldSettleForBrowserResult({ status: "pending" })).toBe(true);
    expect(shouldSettleForBrowserResult({ state: "dispatched" })).toBe(true);
    expect(shouldSettleForBrowserResult({ state: "paused_auth" })).toBe(true);
    expect(shouldSettleForBrowserResult({ state: "paused_offline" })).toBe(
      true,
    );
    expect(shouldSettleForBrowserResult({ status: "completed" })).toBe(false);
  });

  it("rejects arbitrary browser actions and unbounded progress text", () => {
    const tools = purchaseImportTools(
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      unusedService,
    );
    const inputFor = (name: string) => {
      const input = tools.find((tool) => tool.name === name)?.input;
      if (!input) throw new Error(`Missing input schema for ${name}`);
      return input;
    };

    expect(
      v.safeParse(inputFor("issue_browser_command"), {
        operationId: "auth-without-evidence",
        command: { kind: "open_auth" },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(inputFor("report_agent_progress"), {
        operationId: "progress-1",
        phase: "awaiting_approval",
        awaitingApproval: true,
        detail: "x".repeat(1_001),
      }).success,
    ).toBe(false);
  });
});

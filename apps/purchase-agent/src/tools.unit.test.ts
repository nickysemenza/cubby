import { describe, expect, it } from "vitest";
import * as v from "valibot";

import { purchaseImportTools, shouldSettleForBrowserResult } from "./tools";

const unusedService = () => {
  throw new Error("tools only call their service when Flue invokes them");
};

describe("purchase-import agent tool authority", () => {
  it("exposes only run-scoped business tools and makes writes durable", () => {
    const tools = purchaseImportTools(
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      unusedService,
    );
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      "load_run_scope",
      "claim_next_work",
      "issue_browser_command",
      "read_browser_command_result",
      "import_order_evidence",
      "save_navigation_hints",
      "mark_history_expired",
      "audit_batch",
      "finish_run",
      "stop_for_review",
    ]);
    expect(names).not.toContain("sql");
    expect(names).not.toContain("shell");
    expect(names).not.toContain("browser_eval");
    expect(
      tools
        .filter(
          (tool) =>
            tool.name !== "load_run_scope" &&
            tool.name !== "read_browser_command_result",
        )
        .every((tool) => tool.durable),
    ).toBe(true);
  });

  it("settles rather than waiting for an unavailable browser result", () => {
    expect(shouldSettleForBrowserResult({ status: "pending" })).toBe(true);
    expect(shouldSettleForBrowserResult({ state: "pending" })).toBe(true);
    expect(shouldSettleForBrowserResult({ status: "completed" })).toBe(false);
  });

  it("keeps browser result, history, and audit inputs bounded to the service contract", () => {
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
      v.safeParse(inputFor("read_browser_command_result"), {
        operationId: "read-command-4",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(inputFor("import_order_evidence"), {
        operationId: "import-command-4",
        commandId: "command-4",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(inputFor("mark_history_expired"), {
        operationId: "history-4",
        earliestAvailableOrderAt: "2026-09-19T12:30:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(inputFor("audit_batch"), {
        operationId: "audit-4",
        offset: -1,
      }).success,
    ).toBe(false);
  });
});

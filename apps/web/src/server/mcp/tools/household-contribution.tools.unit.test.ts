import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerHouseholdContributionTools } from "./household-contribution.tools";

type RegisteredTools = {
  _registeredTools: Record<
    string,
    { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
  >;
};

describe("registerHouseholdContributionTools", () => {
  it("registers the reviewed-change, reporting, and transfer-suggestion surface", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerHouseholdContributionTools(server);
    const tools = (server as unknown as RegisteredTools)._registeredTools;

    expect(Object.keys(tools)).toEqual([
      "preview_household_ledger_changes",
      "apply_household_ledger_changes",
      "suggest_financial_transfer_pairs",
      "get_household_contribution_ledger",
      "get_project_contribution",
    ]);
    expect(
      tools.preview_household_ledger_changes?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      tools.apply_household_ledger_changes?.annotations?.readOnlyHint,
    ).toBe(false);
    expect(
      tools.suggest_financial_transfer_pairs?.annotations?.readOnlyHint,
    ).toBe(true);
  });
});

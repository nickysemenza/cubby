import { describe, expect, it, vi } from "vitest";

import { isMcpWorkflowCaller, parseMcpWorkflowCaller } from "./caller-contract";
import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer } from "./server";
import { callerMethodRoster, createMcpWorkflowCaller } from "./workflow-caller";

describe("MCP workflow caller contract", () => {
  it("rejects incomplete values from the SDK authInfo bag", () => {
    expect(isMcpWorkflowCaller({ search: { find: vi.fn() } })).toBe(false);
    expect(() => parseMcpWorkflowCaller({ search: { find: vi.fn() } })).toThrow(
      "missing or incomplete",
    );
  });

  it("derives the runtime roster from the same table the caller is bound from", () => {
    // A bound caller has exactly the domains and methods the roster names —
    // both come from `callerDomains`, so a method added there is checked at
    // the SDK boundary without a second list.
    const bound = createMcpWorkflowCaller(
      // SAFETY: binding only captures the context in closures; no method runs.
      {} as Parameters<typeof createMcpWorkflowCaller>[0],
    );
    const boundRoster = Object.fromEntries(
      Object.entries(bound).map(([domain, methods]) => [
        domain,
        Object.fromEntries(Object.keys(methods).map((m) => [m, true])),
      ]),
    );
    expect(boundRoster).toEqual(callerMethodRoster);
    expect(isMcpWorkflowCaller(bound)).toBe(true);
  });

  it("expands the narrow test port into the complete caller contract", async () => {
    const getAllTags = vi.fn(async () => ["dinner"]);
    const result = await callMcpTool(
      createMcpServer(),
      "get_recipe_tags",
      {},
      { recipe: { getAllTags } },
    );

    expect(result.isError).not.toBe(true);
    expect(getAllTags).toHaveBeenCalledOnce();
  });
});

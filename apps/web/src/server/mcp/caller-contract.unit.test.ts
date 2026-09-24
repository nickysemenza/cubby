import { describe, expect, it, vi } from "vitest";

import { isMcpWorkflowCaller, parseMcpWorkflowCaller } from "./caller-contract";
import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer } from "./server";
import { createMcpWorkflowCaller } from "./workflow-caller";

describe("MCP workflow caller contract", () => {
  it("rejects incomplete values from the SDK authInfo bag", () => {
    expect(isMcpWorkflowCaller({ search: { find: vi.fn() } })).toBe(false);
    expect(() => parseMcpWorkflowCaller({ search: { find: vi.fn() } })).toThrow(
      "missing or incomplete",
    );
  });

  it("recognizes a fully bound caller at the SDK boundary", () => {
    const bound = createMcpWorkflowCaller(
      // SAFETY: binding only captures the context in closures; no method runs.
      {} as Parameters<typeof createMcpWorkflowCaller>[0],
    );
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

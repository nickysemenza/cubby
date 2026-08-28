import { describe, expect, it, vi } from "vitest";

import { isMcpWorkflowCaller, parseMcpWorkflowCaller } from "./caller-contract";
import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer } from "./server";

describe("MCP workflow caller contract", () => {
  it("rejects incomplete values from the SDK authInfo bag", () => {
    expect(isMcpWorkflowCaller({ search: { find: vi.fn() } })).toBe(false);
    expect(() => parseMcpWorkflowCaller({ search: { find: vi.fn() } })).toThrow(
      "missing or incomplete",
    );
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

import { describe, expect, it } from "vitest";
import { MCP_APP_MANIFEST, mcpAppResourceUriForTool } from "./metadata";

describe("MCP App metadata", () => {
  it("has one stable URI for each rendered tool", () => {
    expect(MCP_APP_MANIFEST.map((app) => app.uri)).toEqual([
      "ui://cubby/usda-picker.html",
    ]);
    for (const app of MCP_APP_MANIFEST) {
      expect(mcpAppResourceUriForTool(app.toolName)).toBe(app.uri);
    }
    expect(mcpAppResourceUriForTool("get_shopping_list")).toBeUndefined();
    expect(mcpAppResourceUriForTool("list_products")).toBeUndefined();
  });
});

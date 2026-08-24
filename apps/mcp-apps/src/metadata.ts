/**
 * The public identity of every MCP App.
 *
 * This module deliberately contains no built HTML import. MCP tool registration
 * needs the URI lookup on every tool, while only the resource registrar needs
 * the large self-contained document.
 */
export const MCP_APP_MANIFEST = [
  {
    id: "shopping-list",
    toolName: "get_shopping_list",
    uri: "ui://cubby/shopping-list.html",
    name: "Shopping List",
    description:
      "Checkable meal-plan shopping list grouped by availability, with price coverage, omissions, and per-meal detail.",
  },
  {
    id: "usda-picker",
    toolName: "search_usda_foods",
    uri: "ui://cubby/usda-picker.html",
    name: "USDA Food Picker",
    description:
      "Refinable USDA search results with source explanations, match evidence, existing Cubby links, and macros per 100g.",
  },
] as const;

export type McpAppId = (typeof MCP_APP_MANIFEST)[number]["id"];

export function isMcpAppId(value: string): value is McpAppId {
  return MCP_APP_MANIFEST.some((app) => app.id === value);
}

export function mcpAppResourceUriForTool(toolName: string): string | undefined {
  return MCP_APP_MANIFEST.find((app) => app.toolName === toolName)?.uri;
}

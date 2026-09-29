/** The one MCP App resource Cubby serves. */
export const USDA_PICKER = {
  toolName: "usda_food",
  uri: "ui://cubby/usda-picker.html",
  name: "USDA Food Picker",
  description:
    "Refinable USDA search results with source explanations, match evidence, existing Cubby links, and macros per 100g.",
} as const;

export function mcpAppResourceUriForTool(toolName: string): string | undefined {
  return toolName === USDA_PICKER.toolName ? USDA_PICKER.uri : undefined;
}

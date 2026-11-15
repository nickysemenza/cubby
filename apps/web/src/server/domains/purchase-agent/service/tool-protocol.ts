export const CLAIM_IMPORT_WORK_TOOL = "claim_next_import_work";
export const MCP_TOOL_PREFIX = "mcp__";
export const CUBBY_MCP_TOOL_PREFIX = `${MCP_TOOL_PREFIX}cubby__`;

/** Only whole read-only tools qualify; mixed read/write tools stay outside code. */
export const codeReadableTool = (name: string): boolean =>
  name === `${CUBBY_MCP_TOOL_PREFIX}entity_read` ||
  name === `${CUBBY_MCP_TOOL_PREFIX}purchase_import_read`;

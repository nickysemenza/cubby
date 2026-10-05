import {
  importRunAgentManifest,
  type AgentImportRunPurpose,
} from "@cubby/schemas/import-run-agent";

import { MCP_TOOLS } from "~/contracts/mcp-tools";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";

import {
  compiledMcpTools,
  narrowedToolSchema,
} from "./tools/tool-registration";

/**
 * The tools a purchase agent mounts, each narrowed to its `allowed` actions:
 * what `tools/list` answers that agent, and what the agent mounts without
 * listing (`purchaseAgentToolCatalog`).
 */
export function purchaseAgentTools(allowed: ReadonlySet<string>) {
  return compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOLS).flatMap((tool) => {
    const narrowed = narrowedToolSchema(tool, allowed);
    return narrowed
      ? [
          {
            name: tool.name,
            description: narrowed.description,
            inputSchema: narrowed.inputJsonSchema,
          },
        ]
      : [];
  });
}

/** The MCP tools a run purpose's agent mounts, as `tools/list` describes them. */
export function purchaseAgentToolCatalog(purpose: AgentImportRunPurpose) {
  return purchaseAgentTools(
    new Set(importRunAgentManifest[purpose].mcpActions),
  );
}

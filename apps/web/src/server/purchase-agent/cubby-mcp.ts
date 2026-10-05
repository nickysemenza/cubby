import { Type, type JsonObject } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import type { McpToolDefinition, RunServices } from "./environment";

// The transport needs a URL. No request leaves the Worker: `mcpFetch` hands
// it to Cubby's MCP handler in process with the run's bearer.
const MCP_PLACEHOLDER_URL = "https://cubby-mcp.invalid/mcp";
const MCP_TOOL_PREFIX = "mcp__cubby__";

/** The private Cubby MCP server's transport for one run. */
function cubbyMcpFetch(services: () => RunServices): typeof fetch {
  return (input, init) => services().mcpFetch(new Request(input, init));
}

async function connectCubbyMcp(services: () => RunServices): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(MCP_PLACEHOLDER_URL),
    { fetch: cubbyMcpFetch(services) },
  );
  const client = new Client({ name: "cubby-purchase-agent", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const imageBlock = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
const callResult = z.object({
  content: z.array(z.unknown()).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

function toolResult(raw: unknown): ToolExecutionResult {
  const parsed = callResult.parse(raw);
  const content: NonNullable<ToolExecutionResult["content"]> = [];
  for (const block of parsed.content) {
    const text = textBlock.safeParse(block);
    if (text.success) content.push({ type: "text", text: text.data.text });
    const image = imageBlock.safeParse(block);
    if (image.success) content.push(image.data);
  }
  if (content.length === 0 && parsed.structuredContent !== undefined)
    content.push({
      type: "text",
      text: JSON.stringify(parsed.structuredContent),
    });
  return { content, isError: parsed.isError === true };
}

/**
 * Cubby MCP tools as pi tools named `mcp__cubby__<tool>`. Replay is safe:
 * every mutation carries the run's `_runExecution` operation id and the
 * server replays an identical effect instead of repeating it.
 */
export function cubbyMcpExtension(
  tools: readonly McpToolDefinition[],
  services: () => RunServices,
): Extension {
  let client: Promise<Client> | undefined;
  const connected = () => {
    client ??= connectCubbyMcp(services).catch((error) => {
      client = undefined;
      throw error;
    });
    return client;
  };
  return defineExtension({
    name: "cubby.mcp",
    tools: tools.map((tool) =>
      defineTool({
        name: `${MCP_TOOL_PREFIX}${tool.name}`,
        description: tool.description,
        // MCP tool input schemas are always JSON-Schema objects.
        parameters: Type.Unsafe<JsonObject>(tool.inputSchema),
        replay: "safe",
        execute: async (args, _api, context) =>
          toolResult(
            await (
              await connected()
            ).callTool(
              { name: tool.name, arguments: args },
              { signal: context.abortSignal },
            ),
          ),
      }),
    ),
  });
}

import {
  importRunAgentManifest,
  type AgentImportRunPurpose,
} from "@cubby/schemas/import-run-agent";
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

import type { PurchaseImportServiceResolver } from "./tools";

const mcpAccess = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  mcpUrl: z.url(),
});

// The transport needs a URL synchronously. No request reaches this host: the
// fetch below rewrites it to the URL the run-bound grant authorizes and sends
// it over the service binding.
const MCP_PLACEHOLDER_URL = "https://cubby-mcp.invalid/mcp";
export const MCP_TOOL_PREFIX = "mcp__cubby__";

/** What the agent caches per run so a cold start never lists tools again. */
export const cachedMcpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.json()),
});
export type CachedMcpTool = z.infer<typeof cachedMcpToolSchema>;

async function rewriteMcpRequest(
  request: Request,
  mcpUrl: string,
  token: string,
): Promise<Request> {
  const target = new URL(mcpUrl);
  target.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  // A transport-owned AbortSignal cannot be structured-cloned across a Worker
  // RPC service binding; rebuild the small MCP request from bytes.
  return new Request(target, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    redirect: request.redirect,
  });
}

/**
 * The private Cubby MCP server's transport for one run. The bearer comes from
 * the run's access grant on every request and is never stored in durable
 * agent state; requests cross only the Worker service binding.
 */
export function cubbyMcpFetch(
  runId: string,
  serviceForRun: PurchaseImportServiceResolver,
): typeof fetch {
  return async (input, init) => {
    const access = mcpAccess.parse(
      await serviceForRun().acquireMcpAccess({ runId }),
    );
    return serviceForRun().mcpFetch(
      await rewriteMcpRequest(
        new Request(input, init),
        access.mcpUrl,
        access.token,
      ),
    );
  };
}

async function connectCubbyMcp(
  runId: string,
  serviceForRun: PurchaseImportServiceResolver,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(MCP_PLACEHOLDER_URL),
    { fetch: cubbyMcpFetch(runId, serviceForRun) },
  );
  const client = new Client({ name: "cubby-purchase-agent", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** The purpose's manifest tools, as the server describes them. */
export async function listCubbyMcpTools(
  runId: string,
  purpose: AgentImportRunPurpose,
  serviceForRun: PurchaseImportServiceResolver,
): Promise<CachedMcpTool[]> {
  const client = await connectCubbyMcp(runId, serviceForRun);
  try {
    return mountedMcpTools(purpose, (await client.listTools()).tools);
  } finally {
    await client.close();
  }
}

/**
 * Every mounted tool's schema rides on every model call, so each purpose
 * mounts only its manifest list, never the household catalog.
 */
export function mountedMcpTools(
  purpose: AgentImportRunPurpose,
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>,
): CachedMcpTool[] {
  const mounted = new Set<string>(importRunAgentManifest[purpose].mcpTools);
  return tools
    .filter((tool) => mounted.has(tool.name))
    .map((tool) =>
      cachedMcpToolSchema.parse({
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema,
      }),
    );
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
  runId: string,
  tools: readonly CachedMcpTool[],
  serviceForRun: PurchaseImportServiceResolver,
): Extension {
  let client: Promise<Client> | undefined;
  const connected = () => {
    client ??= connectCubbyMcp(runId, serviceForRun).catch((error) => {
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

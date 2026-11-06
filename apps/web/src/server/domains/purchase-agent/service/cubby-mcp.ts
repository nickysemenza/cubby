import {
  MAIL_READ_RESPONSE_MAX_BYTES,
  mailAttachmentOriginal,
  mailReadAgentText,
  mailResolveOut,
} from "@cubby/schemas/mailbox-research";
import { sha256Hex } from "@cubby/shared/sha256";
import type { Context } from "@earendil-works/chord";
import { Type, type JsonObject } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import type { McpToolDefinition, RunServices } from "./environment";
import type { MailAttemptEvidence } from "./mail-attempts";

// The transport needs a URL. No request leaves the Worker: `mcpFetch` hands
// it to Cubby's MCP handler in process with the run's bearer.
const MCP_PLACEHOLDER_URL = "https://cubby-mcp.invalid/mcp";
const MCP_TOOL_PREFIX = "mcp__cubby__";
// Cubby's MCP handler serves only the modern era. A pin fails loudly instead
// of falling back to the `initialize` handshake the handler rejects.
const MCP_PROTOCOL_VERSION = "2026-07-28";
// `purchase_import_read.mail_read` sizes its compact text or raw HTML page under
// MAIL_READ_RESPONSE_MAX_BYTES; pi's default 50 KB head cap would cut a long
// order's last item lines and totals.
const EMAIL_READ_OUTPUT_LIMITS = {
  maxBytes: MAIL_READ_RESPONSE_MAX_BYTES,
  maxLines: 10_000,
};

/** The private Cubby MCP server's transport for one run. */
function cubbyMcpFetch(services: () => RunServices): typeof fetch {
  return (input, init) => services().mcpFetch(new Request(input, init));
}

async function connectCubbyMcp(services: () => RunServices): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(MCP_PLACEHOLDER_URL),
    { fetch: cubbyMcpFetch(services) },
  );
  const client = new Client(
    { name: "cubby-purchase-agent", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
  );
  await client.connect(transport);
  return client;
}

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const imageBlock = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
const attachmentResult = z.looseObject({
  originalAttachment: mailAttachmentOriginal,
});
const callResult = z.object({
  content: z.array(z.unknown()).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  _meta: z
    .object({
      "cubby/error": z
        .object({
          message: z.string(),
          code: z.string().optional(),
          reason: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

/** A Cubby MCP call result as the agent's tool output. */
/**
 * The MCP client gives up at 60s by default while the server keeps working, so a
 * long mail search reads as a failure and its Email can end unresolved.
 */
const TOOL_CALL_TIMEOUT_MS = 180_000;

/** Exhaustion records a source gap through the same delegated writer as Pi. */
export async function settleMailAttemptLimit(input: {
  services: () => RunServices;
  runId: string;
  source: MailAttemptEvidence;
  generation: string;
}) {
  const client = await connectCubbyMcp(input.services);
  try {
    const outcome = await client.callTool(
      {
        name: "purchase_import",
        arguments: {
          action: "mail_resolve",
          input: {
            mailboxId: input.source.mailboxId,
            messageId: input.source.messageId,
            checksum: input.source.checksum,
            disposition: {
              kind: "unresolved",
              reason:
                "The bounded extraction and repair attempts could not establish a safe import. Retained evidence needs review.",
            },
          },
          _runExecution: {
            runId: input.runId,
            operationId: `attempt-limit:${await sha256Hex(JSON.stringify(input.source))}`,
            generation: input.generation,
          },
        },
      },
      { timeout: TOOL_CALL_TIMEOUT_MS },
    );
    const parsed = callResult.parse(outcome);
    if (parsed.isError)
      return { kind: "refused" as const, diagnostic: JSON.stringify(outcome) };
    const text = parsed.content
      .map((part) => textBlock.safeParse(part).data?.text)
      .find((part) => part !== undefined);
    const resolved = mailResolveOut.parse(
      parsed.structuredContent ?? JSON.parse(text ?? "null"),
    );
    if (
      resolved.mailboxId !== input.source.mailboxId ||
      resolved.messageId !== input.source.messageId ||
      resolved.disposition !== "unresolved"
    )
      throw new Error(
        "Mail attempt-limit result did not confirm this source's unresolved outcome.",
      );
    return { kind: "settled" as const };
  } finally {
    await client.close();
  }
}

export function cubbyToolResult(raw: unknown): ToolExecutionResult {
  const parsed = callResult.parse(raw);
  // Only server metadata supplies retry codes. Email text is untrusted and
  // must never classify the outcome of a writer.
  const error = parsed.isError ? parsed._meta?.["cubby/error"] : undefined;
  const diagnostics: ToolExecutionResult["diagnostics"] = error
    ? [
        {
          severity: "error",
          message: error.message,
          code: error.reason ?? error.code,
        },
      ]
    : undefined;
  const content: NonNullable<ToolExecutionResult["output"]> = [];
  for (const block of parsed.content) {
    const text = textBlock.safeParse(block);
    if (text.success) content.push({ type: "text", text: text.data.text });
    const image = imageBlock.safeParse(block);
    if (image.success) content.push(image.data);
  }
  // `purchase_import_read.mail_read` returns an attachment's original bytes; the model receives
  // them as media rather than as base64 text.
  const original = attachmentResult.safeParse(parsed.structuredContent);
  if (original.success) {
    const { dataBase64, mimeType } = original.data.originalAttachment;
    return {
      output: [
        {
          type: "text",
          text: mailReadAgentText(original.data),
        },
        { type: "image", data: dataBase64, mimeType },
      ],
      isError: parsed.isError === true,
      diagnostics,
    };
  }
  if (content.length === 0 && parsed.structuredContent !== undefined)
    content.push({
      type: "text",
      text: JSON.stringify(parsed.structuredContent),
    });
  return { output: content, isError: parsed.isError === true, diagnostics };
}

/**
 * Cubby MCP tools as pi tools named `mcp__cubby__<tool>`. Replay is safe:
 * import writers carry the run's `_runExecution` operation id and replay an
 * identical effect; `purchase_import.mail_resolve` is idempotent by its Email and outcome.
 */
export function cubbyMcpExtension(
  tools: readonly McpToolDefinition[],
  services: () => RunServices,
  /** The dispatch generation of the request that issued this tool call. */
  generationFor?: (
    api: ToolExecutionApi,
    context: Context,
  ) => Promise<string | undefined>,
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
        ...(tool.name === "purchase_import_read"
          ? { outputLimits: EMAIL_READ_OUTPUT_LIMITS }
          : {}),
        execute: async (args, api, context) =>
          cubbyToolResult(
            await (
              await connected()
            ).callTool(
              {
                name: tool.name,
                arguments: await stampGeneration(args, () =>
                  generationFor?.(api, context),
                ),
              },
              { signal: context.abortSignal, timeout: TOOL_CALL_TIMEOUT_MS },
            ),
          ),
      }),
    ),
  });
}

/**
 * Overwrite any model-written `_runExecution.generation` with the host's own
 * record of the issuing request's generation; the bearer minted for the call
 * signs it, and the server fences superseded generations by it. A model that
 * also names its Run's public `run` code beside `runId` is dropped to `runId`:
 * the envelope refuses both, and the delegation already binds the Run.
 */
export async function stampGeneration(
  args: JsonObject,
  generation: () => Promise<string | undefined> | undefined,
): Promise<JsonObject> {
  const envelope = args._runExecution;
  if (!isJsonObject(envelope)) return args;
  const { generation: _claimed, ...claimed } = envelope;
  const { run: _publicRun, ...withoutRun } = claimed;
  const rest = claimed.runId === undefined ? claimed : withoutRun;
  const stamped = await generation();
  return {
    ...args,
    _runExecution: stamped ? { ...rest, generation: stamped } : rest,
  };
}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

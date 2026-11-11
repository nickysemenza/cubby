import {
  MAIL_READ_RESPONSE_MAX_BYTES,
  mailAttachmentOriginal,
  mailReadAgentText,
  mailResolveOut,
} from "@cubby/schemas/mailbox-research";
import {
  photoGroupProposalList,
  proposePhotoGroupsOutput,
} from "@cubby/schemas/photo-import-run";
import { sha256Hex } from "@cubby/shared/sha256";
import type { Context } from "@earendil-works/chord";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
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
import { CLAIM_IMPORT_WORK_TOOL, CUBBY_MCP_TOOL_PREFIX } from "./tool-protocol";

// The transport needs a URL. No request leaves the Worker: `mcpFetch` hands
// it to Cubby's MCP handler in process with the run's bearer.
const MCP_PLACEHOLDER_URL = "https://cubby-mcp.invalid/mcp";
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
          diagnostics: z.object({ stage: z.string().optional() }).optional(),
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
              category: "attempt_limit",
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
          code: `cubby:${
            error.diagnostics?.stage === "output"
              ? "RUN_OPERATION_OUTCOME_UNCERTAIN"
              : (error.reason ?? error.code ?? "UNKNOWN_ERROR")
          }`,
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

/** Decision inputs remain in the transcript; complete rosters remain in durable proposals. */
export function photoCoordinatorToolResult(
  tool: string,
  args: JsonObject,
  result: z.output<typeof callResult>,
): ToolExecutionResult {
  if (tool !== "run" && tool !== "run_read") return cubbyToolResult(result);
  if (result.isError) return cubbyToolResult(result);
  const written = tool === "run" && args.action === "propose_groups";
  const read = tool === "run_read" && args.action === "proposals";
  if (!written && !read) return cubbyToolResult(result);
  const text = result.content
    .flatMap((part) => textBlock.safeParse(part).data?.text ?? [])
    .at(0);
  const value: unknown =
    result.structuredContent ?? (text ? JSON.parse(text) : undefined);
  const list = photoGroupProposalList.parse(value);
  const submitted = z
    .object({ groups: z.array(z.object({ groupKey: z.string() })).default([]) })
    .parse(args);
  const frozen = written
    ? proposePhotoGroupsOutput.parse(value).frozenGroupKeys
    : [];
  const compact = {
    runId: list.runId,
    runStatus: list.runStatus,
    proposalCount: list.proposals.length,
    unassignedImageCount: list.unassignedImageIds.length,
    conflictedGroupCount: list.proposals.filter(
      (group) => group.conflict?.length,
    ).length,
    failedGroupCount: list.proposals.filter((group) => group.lastError).length,
    // Repair the first outstanding groups, then read again for the next batch.
    groupsNeedingRepair: list.proposals
      .filter((group) => group.conflict?.length || group.lastError)
      .slice(0, 8)
      .map((group) => ({
        groupKey: group.groupKey,
        conflict: group.conflict?.slice(0, 8) ?? null,
        lastError: group.lastError?.slice(0, 2000) ?? null,
      })),
    ...(written
      ? {
          savedGroupKeys: submitted.groups
            .map((group) => group.groupKey)
            .filter((key) => !frozen.includes(key)),
          frozenGroupKeys: frozen,
        }
      : {}),
  };
  return {
    output: [{ type: "text", text: JSON.stringify(compact) }],
    isError: false,
  };
}

type WriterResult = Pick<ToolExecutionResult, "isError" | "diagnostics">;

/** Only the MCP adapter emits this prefix; source text cannot supply a verdict. */
export function hasWriterVerdict(result: WriterResult): boolean {
  return (
    result.diagnostics?.some((item) => item.code?.startsWith("cubby:")) ?? false
  );
}

export function mailWriterOutcome({
  result,
  stage,
}: {
  result: WriterResult;
  stage: "prepare" | "commit";
}): "complete" | "exempt" | "invalid" | "pending" {
  if (!result.isError) return "complete";
  const reasons = result.diagnostics?.map((item) => item.code) ?? [];
  if (reasons.includes("cubby:MAIL_SOURCE_HELD_BY_RUN")) return "exempt";
  const uncertain =
    !hasWriterVerdict(result) ||
    reasons.includes("cubby:MCP_TOOL_DEADLINE_EXCEEDED") ||
    reasons.includes("cubby:RUN_OPERATION_OUTCOME_UNCERTAIN");
  // Preparation publishes no money. Transport failures do not spend a
  // semantic repair; an uncertain commit must retain the exact replay input.
  if (uncertain) return stage === "prepare" ? "exempt" : "pending";
  return "invalid";
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
  runId?: string,
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
        name: `${CUBBY_MCP_TOOL_PREFIX}${tool.name}`,
        description: tool.description,
        // MCP tool input schemas are always JSON-Schema objects.
        parameters: tool.inputSchema,
        replay: "safe",
        ...(tool.name === "purchase_import_read"
          ? { outputLimits: EMAIL_READ_OUTPUT_LIMITS }
          : {}),
        execute: async (raw, api, context) => {
          // pi validated `raw` against the object schema above.
          if (!isJsonObject(raw))
            throw new Error(`${tool.name} arguments must be an object`);
          const args = raw;
          const result = photoCoordinatorToolResult(
            tool.name,
            args,
            callResult.parse(
              await (
                await connected()
              ).callTool(
                {
                  name: tool.name,
                  arguments: await stampGeneration(
                    args,
                    () => generationFor?.(api, context),
                    runId,
                  ),
                },
                { signal: context.abortSignal, timeout: TOOL_CALL_TIMEOUT_MS },
              ),
            ),
          );
          // A settled Mail source continues with the next durable claim, as
          // `import_extracted_order` does, instead of a claim-only model turn.
          if (
            !runId ||
            result.isError ||
            tool.name !== "purchase_import" ||
            args.action !== "mail_resolve"
          )
            return result;
          const next = await api.executeTool(
            CLAIM_IMPORT_WORK_TOOL,
            {},
            context,
            {
              key: "next-work",
            },
          );
          const nextWork = continuationOf(next);
          return {
            ...result,
            output: [
              ...(result.output ?? []),
              {
                type: "text",
                text: JSON.stringify({ kind: RESOLVE_CONTINUATION, nextWork }),
              },
            ],
          };
        },
      }),
    ),
  });
}

/** The tool-result part that carries a resolved Email's next work item. */
const RESOLVE_CONTINUATION = "resolve_result";

/** The nested claim's result, or a request to claim again when unreadable. */
function continuationOf(next: {
  isError?: boolean;
  structuredOutput?: unknown;
}): JsonValue {
  const retry = { kind: "retry" };
  if (next.isError) return retry;
  try {
    const value =
      typeof next.structuredOutput === "string"
        ? JSON.parse(next.structuredOutput)
        : next.structuredOutput;
    return z.json().safeParse(value).data ?? retry;
  } catch {
    // SILENT: an unreadable continuation asks for a new claim.
    return retry;
  }
}

/**
 * Overwrite any model-written `_runExecution.generation` with the host's own
 * record of the issuing request's generation; the bearer minted for the call
 * signs it, and the server fences superseded generations by it. A model that
 * also names its Run's public `run` code beside `runId` is dropped to `runId`.
 * Mail supplies the immutable delegated Run here instead of asking the model
 * to repeat it. Email/checksum and operation ids stay in the saved arguments.
 */
export async function stampGeneration(
  args: JsonObject,
  generation: () => Promise<string | undefined> | undefined,
  runId?: string,
): Promise<JsonObject> {
  const nested = runId && isJsonObject(args.input) ? args.input : undefined;
  const envelope =
    args._runExecution === undefined
      ? nested?._runExecution
      : args._runExecution;
  if (!isJsonObject(envelope)) return args;
  const { generation: _claimed, ...claimed } = envelope;
  const { run: _publicRun, ...withoutRun } = claimed;
  const rest = runId
    ? { ...withoutRun, runId }
    : claimed.runId === undefined
      ? claimed
      : withoutRun;
  const stamped = await generation();
  return {
    ...args,
    // Describe may place the envelope inside a compact action's input. Mail
    // signs it at the root before the server flattens that input.
    ...(nested && isJsonObject(nested._runExecution)
      ? {
          input: Object.fromEntries(
            Object.entries(nested).filter(([key]) => key !== "_runExecution"),
          ),
        }
      : {}),
    _runExecution: stamped ? { ...rest, generation: stamped } : rest,
  };
}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

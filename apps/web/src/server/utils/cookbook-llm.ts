import {
  chunkRequestInput,
  chunkResponseOut,
} from "@cubby/schemas/import-recipe";
import { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import { recordAiUsage } from "~/server/ai-usage";
import {
  COOKBOOK_ESCALATION_MODEL,
  DEFAULT_CHAT_MODEL,
  type SupportedChatModel,
} from "~/server/ai/models";
import { gatewayAdapterConfig } from "~/server/clients/gateway-config";
import type { Database } from "~/server/db";

const MAX_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 120_000;

type CookbookChunkRequest = z.output<typeof chunkRequestInput>;
type CookbookChunkResponse = z.output<typeof chunkResponseOut>;
type CookbookErrorKind = NonNullable<CookbookChunkResponse["error"]>["kind"];

type AnthropicCookbookRequest = {
  model: SupportedChatModel;
  max_tokens: number;
  system: Array<{
    type: "text";
    text: string;
    cache_control: { type: "ephemeral" };
  }>;
  messages: Array<{ role: "user"; content: string }>;
  tools: Array<{
    name: string;
    description: string;
    input_schema: CookbookChunkRequest["toolSchema"];
  }>;
  tool_choice: { type: "tool"; name: string };
};

type AnthropicGatewayRequest = {
  provider: "anthropic";
  endpoint: string;
  headers: Record<string, string>;
  query: AnthropicCookbookRequest;
};

export interface CookbookLlmPort {
  request: (
    body: AnthropicCookbookRequest,
    signal: AbortSignal,
  ) => Promise<Response>;
}

const anthropicResponseSchema = z.object({
  content: z.json().optional(),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
  }),
});

const providerErrorSchema = z.object({
  error: z.object({ message: z.string() }),
});

const jsonObjectSchema = z.record(z.string(), z.json());
const cookbookInputSchema = z.object({ recipes: z.array(z.json()) });
const toolUseBlocksSchema = z.array(
  z
    .object({
      type: z.string(),
      name: z.string().optional(),
      input: z.json().optional(),
    })
    .passthrough(),
);

class CookbookProviderError extends Error {
  constructor(
    message: string,
    readonly kind: CookbookErrorKind,
  ) {
    super(message);
    this.name = "CookbookProviderError";
  }
}

function gatewayMetadataHeaders(metadata: Record<string, string>) {
  return { "cf-aig-metadata": JSON.stringify(metadata) };
}

async function requestAnthropic(
  body: AnthropicCookbookRequest,
  signal: AbortSignal,
): Promise<Response> {
  const metadata = {
    feature: "cookbook-epub-parsing",
    operation:
      body.model === COOKBOOK_ESCALATION_MODEL
        ? "extractCookbookChunk.escalated"
        : "extractCookbookChunk",
    model: body.model,
  };
  const config = gatewayAdapterConfig({ metadata });
  const headers = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    ...gatewayMetadataHeaders(metadata),
  };
  const request: AnthropicGatewayRequest = {
    provider: "anthropic",
    endpoint: "messages",
    headers,
    query: body,
  };
  if ("binding" in config) {
    return config.binding.run(request, { signal });
  }
  return fetch(
    `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-aig-authorization": `Bearer ${config.cfApiKey}`,
        ...gatewayMetadataHeaders(metadata),
      },
      body: JSON.stringify(request),
      signal,
    },
  );
}

const productionCookbookLlmPort: CookbookLlmPort = {
  request: requestAnthropic,
};

const emptyUsage = (): CookbookChunkResponse["usage"] => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

function serializeUsage(
  usage: z.output<typeof anthropicResponseSchema>["usage"],
): CookbookChunkResponse["usage"] {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

async function parseResponse(response: Response) {
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CookbookProviderError(
      `Cookbook extraction returned invalid JSON (HTTP ${response.status})`,
      response.ok ? "payload" : "transport",
    );
  }
  if (!response.ok) {
    const error = providerErrorSchema.safeParse(json);
    throw new CookbookProviderError(
      error.success
        ? error.data.error.message
        : `Cookbook extraction failed with HTTP ${response.status}`,
      response.status === 400 || response.status === 422
        ? "payload"
        : "transport",
    );
  }
  const parsed = anthropicResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new CookbookProviderError(
      "Cookbook extraction returned malformed provider metadata",
      "payload",
    );
  }
  return parsed.data;
}

function extractInput(
  content: z.output<typeof anthropicResponseSchema>["content"],
  toolName: string,
) {
  const blocks = toolUseBlocksSchema.safeParse(content);
  const block = blocks.success
    ? blocks.data.find(
        (candidate) =>
          candidate.type === "tool_use" && candidate.name === toolName,
      )
    : undefined;
  const parsed = jsonObjectSchema.safeParse(block?.input);
  if (!parsed.success || !cookbookInputSchema.safeParse(parsed.data).success) {
    throw new CookbookProviderError(
      "Cookbook extraction returned no structured object",
      "payload",
    );
  }
  return parsed.data;
}

/**
 * Execute one upstream-built EPUB chunk through Cubby's authenticated gateway.
 * Reading the raw provider response here preserves stop reason and the complete
 * Anthropic usage object, which the generic structured-output adapter drops.
 */
export async function extractCookbookChunk(
  req: CookbookChunkRequest,
  opts?: { db?: Database },
  ai: CookbookLlmPort = productionCookbookLlmPort,
): Promise<CookbookChunkResponse> {
  const startedAt = performance.now();
  const model = req.escalate ? COOKBOOK_ESCALATION_MODEL : DEFAULT_CHAT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let usage = emptyUsage();
  let truncated = false;

  try {
    const response = await ai.request(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: "text",
            text: req.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: req.user }],
        tools: [
          {
            name: req.toolName,
            description: "Return the recipes extracted from this EPUB chunk.",
            input_schema: req.toolSchema,
          },
        ],
        tool_choice: { type: "tool", name: req.toolName },
      },
      controller.signal,
    );
    const provider = await parseResponse(response);
    usage = serializeUsage(provider.usage);
    truncated =
      provider.stop_reason === "max_tokens" ||
      provider.stop_reason === "model_context_window_exceeded";
    if (opts?.db) {
      await recordAiUsage(opts.db, {
        feature: "cookbook-epub-parsing",
        provider: "anthropic",
        model,
        operation: req.escalate
          ? "extractCookbookChunk.escalated"
          : "extractCookbookChunk",
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        cacheStatus:
          usage.cache_read_input_tokens > 0
            ? "hit"
            : usage.cache_creation_input_tokens > 0
              ? "miss"
              : "none",
      });
    }
    return {
      input: extractInput(provider.content, req.toolName),
      usage,
      truncated,
    };
  } catch (error) {
    return {
      input: null,
      usage,
      truncated,
      error: {
        message: controller.signal.aborted
          ? "Cookbook extraction timed out"
          : getErrorMessage(error),
        kind:
          controller.signal.aborted || !(error instanceof CookbookProviderError)
            ? "transport"
            : error.kind,
      },
    };
  } finally {
    clearTimeout(timer);
    console.log(
      `[cookbook-llm] ${model} ${Math.round(performance.now() - startedAt)}ms`,
    );
  }
}

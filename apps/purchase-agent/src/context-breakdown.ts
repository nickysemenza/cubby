/**
 * Per-model-call context accounting. Measures what fills each outgoing model
 * request (instructions, tool schemas, conversation, tool results by tool) in
 * characters, then scales those sizes to the provider-reported input tokens.
 * Only sizes and tool names leave this module — never request or response text.
 */
import { z } from "zod";

/** Character weight for one image; base64 length says nothing about tokens. */
export const IMAGE_CHAR_WEIGHT = 4_000;
/** Flue mounts MCP connection tools as `mcp__<server>__<tool>`. */
const MCP_TOOL_PREFIX = "mcp__";
const UNKNOWN_TOOL = "unknown";
const MAX_CALLS_PER_SCOPE = 256;
const MAX_SCOPES = 64;
const CHARS_PER_ESTIMATED_TOKEN = 4;

export type ContextSections = {
  instructions: number;
  agentToolSchemas: number;
  mcpToolSchemas: number;
  conversation: number;
  /** Keyed by the tool name the model called (MCP names keep their prefix). */
  toolResults: Record<string, number>;
};

type ContextCall = {
  model?: string;
  /** Reported input tokens, including cached ones. */
  inputTokens: number;
  cachedTokens: number;
  /** True when the provider reported no usage and tokens are chars / 4. */
  estimated: boolean;
  /** Token counts that sum exactly to `inputTokens`. */
  sections: ContextSections;
};

/** Persisted on each Flue response's metadata as `contextBreakdown`. */
export type ContextBreakdown = { v: 1; calls: ContextCall[] };

export type ReportedUsage = { inputTokens: number; cachedTokens: number };

const emptySections = (): ContextSections => ({
  instructions: 0,
  agentToolSchemas: 0,
  mcpToolSchemas: 0,
  conversation: 0,
  toolResults: {},
});

const jsonValue = z.json();
const optionalName = z.string().optional();
const toolDefinition = z.looseObject({ name: optionalName });
const tools = z.array(toolDefinition).optional();

const responsesItem = z.looseObject({
  type: optionalName,
  role: optionalName,
  call_id: optionalName,
  name: optionalName,
});
const responsesRequest = z.looseObject({
  model: optionalName,
  instructions: jsonValue.optional(),
  input: z.array(responsesItem),
  tools,
});

const messagesBlock = z.looseObject({
  type: optionalName,
  id: optionalName,
  name: optionalName,
  tool_use_id: optionalName,
});
const messagesMessage = z.looseObject({
  role: optionalName,
  content: z.union([z.string(), z.array(messagesBlock)]),
});
const messagesRequest = z.looseObject({
  model: optionalName,
  system: jsonValue.optional(),
  messages: z.array(messagesMessage),
  tools,
});

type ResponsesRequest = z.infer<typeof responsesRequest>;
type MessagesRequest = z.infer<typeof messagesRequest>;
type ModelRequest =
  | { api: "responses"; body: ResponsesRequest }
  | { api: "messages"; body: MessagesRequest };

function parseModelRequest(text: string): ModelRequest | undefined {
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    return undefined;
  }
  const responses = responsesRequest.safeParse(decoded);
  if (responses.success) return { api: "responses", body: responses.data };
  const messages = messagesRequest.safeParse(decoded);
  if (messages.success) return { api: "messages", body: messages.data };
  return undefined;
}

type JsonValue = z.infer<typeof jsonValue>;
/** Every request part this module sizes: parsed items or raw JSON beneath them. */
type Measurable =
  | JsonValue
  | z.infer<typeof toolDefinition>
  | z.infer<typeof responsesItem>
  | z.infer<typeof messagesBlock>
  | z.infer<typeof messagesMessage>
  | undefined;

const imageBlock = z.object({ type: z.enum(["input_image", "image"]) });
const imageDataUrl = z.string().startsWith("data:image/");
const reasoningItem = z.object({
  type: z.literal("reasoning"),
  summary: jsonValue.optional(),
});
// Serialized with its quotes, this counts exactly IMAGE_CHAR_WEIGHT.
const IMAGE_PLACEHOLDER = "i".repeat(IMAGE_CHAR_WEIGHT - 2);

function sizeReplacer(_key: string, value: JsonValue): JsonValue {
  if (
    imageBlock.safeParse(value).success ||
    imageDataUrl.safeParse(value).success
  ) {
    return IMAGE_PLACEHOLDER;
  }
  // Replayed reasoning carries opaque encrypted state; only its summary is
  // readable context, so the ciphertext length is not a token proxy.
  const reasoning = reasoningItem.safeParse(value);
  if (reasoning.success) return reasoning.data.summary ?? null;
  return value;
}

/** Serialized size, with images at a fixed weight. */
const size = (value: Measurable): number =>
  value === undefined ? 0 : (JSON.stringify(value, sizeReplacer)?.length ?? 0);

function addToolResult(
  sections: ContextSections,
  name: string | undefined,
  chars: number,
) {
  const key = name ?? UNKNOWN_TOOL;
  sections.toolResults[key] = (sections.toolResults[key] ?? 0) + chars;
}

function measureTools(
  sections: ContextSections,
  definitions: ResponsesRequest["tools"],
) {
  for (const tool of definitions ?? []) {
    if (tool.name?.startsWith(MCP_TOOL_PREFIX)) {
      sections.mcpToolSchemas += size(tool);
    } else {
      sections.agentToolSchemas += size(tool);
    }
  }
}

const isToolCall = (item: z.infer<typeof responsesItem>) =>
  item.type === "function_call" || item.type === "custom_tool_call";
const isToolOutput = (item: z.infer<typeof responsesItem>) =>
  item.type === "function_call_output" ||
  item.type === "custom_tool_call_output";

function measureResponses(body: ResponsesRequest) {
  const sections = emptySections();
  sections.instructions += size(body.instructions);
  measureTools(sections, body.tools);
  const callNames = new Map<string, string>();
  for (const item of body.input) {
    if (isToolCall(item) && item.call_id && item.name) {
      callNames.set(item.call_id, item.name);
    }
  }
  for (const item of body.input) {
    if (item.role === "system" || item.role === "developer") {
      sections.instructions += size(item);
    } else if (isToolOutput(item)) {
      addToolResult(
        sections,
        item.call_id ? callNames.get(item.call_id) : undefined,
        size(item),
      );
    } else {
      sections.conversation += size(item);
    }
  }
  return sections;
}

function measureMessages(body: MessagesRequest) {
  const sections = emptySections();
  sections.instructions += size(body.system);
  measureTools(sections, body.tools);
  const toolNames = new Map<string, string>();
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id && block.name) {
        toolNames.set(block.id, block.name);
      }
    }
  }
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) {
      sections.conversation += size(message);
      continue;
    }
    sections.conversation += size(message.role);
    for (const block of message.content) {
      if (block.type === "tool_result") {
        addToolResult(
          sections,
          block.tool_use_id ? toolNames.get(block.tool_use_id) : undefined,
          size(block),
        );
      } else {
        sections.conversation += size(block);
      }
    }
  }
  return sections;
}

const measureParsed = (request: ModelRequest) =>
  request.api === "responses"
    ? measureResponses(request.body)
    : measureMessages(request.body);

/**
 * Serialized sizes of an OpenAI Responses or Anthropic Messages request body.
 * Model settings outside the prompt (model id, reasoning effort) are ignored.
 */
export function measureRequestContext(text: string): ContextSections {
  const request = parseModelRequest(text);
  return request ? measureParsed(request) : emptySections();
}

const FIXED_KEYS = [
  "instructions",
  "agentToolSchemas",
  "mcpToolSchemas",
  "conversation",
] as const;
type FixedKey = (typeof FIXED_KEYS)[number];

const sectionTotal = (sections: ContextSections) =>
  FIXED_KEYS.reduce((sum, key) => sum + sections[key], 0) +
  Object.values(sections.toolResults).reduce((sum, n) => sum + n, 0);

type ScaledEntry = ({ fixed: FixedKey } | { tool: string }) & {
  floor: number;
  rest: number;
};

/**
 * Proportional integer scaling (largest remainder) so the sections sum to
 * exactly `inputTokens`.
 */
export function scaleContextSections(
  sections: ContextSections,
  inputTokens: number,
): ContextSections {
  const target = Math.max(0, Math.round(inputTokens));
  const totalChars = sectionTotal(sections);
  if (totalChars === 0) return { ...emptySections(), conversation: target };
  const share = (chars: number) => {
    const exact = (chars * target) / totalChars;
    const floor = Math.floor(exact);
    return { floor, rest: exact - floor };
  };
  const entries: ScaledEntry[] = [
    ...FIXED_KEYS.map((fixed) => ({ fixed, ...share(sections[fixed]) })),
    ...Object.entries(sections.toolResults).map(([tool, chars]) => ({
      tool,
      ...share(chars),
    })),
  ];
  let remaining = target - entries.reduce((sum, e) => sum + e.floor, 0);
  for (const entry of [...entries].sort((a, b) => b.rest - a.rest)) {
    if (remaining <= 0) break;
    entry.floor += 1;
    remaining -= 1;
  }
  const scaled = emptySections();
  for (const entry of entries) {
    if ("fixed" in entry) scaled[entry.fixed] = entry.floor;
    else scaled.toolResults[entry.tool] = entry.floor;
  }
  return scaled;
}

const tokenCount = z.number().nonnegative().nullish();
const reportedUsage = z.object({
  input_tokens: z.number().nonnegative(),
  input_tokens_details: z.object({ cached_tokens: tokenCount }).nullish(),
  cache_read_input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
});
// OpenAI streams `response.*` events, Anthropic `message_start` then
// `message_delta`; a non-streaming body carries top-level `usage`.
const usageCarrier = z.object({
  response: z.object({ usage: reportedUsage.nullish() }).nullish(),
  message: z.object({ usage: reportedUsage.nullish() }).nullish(),
  usage: reportedUsage.nullish(),
});

function usageFromJson(text: string): ReportedUsage | undefined {
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    return undefined;
  }
  const carrier = usageCarrier.safeParse(decoded);
  if (!carrier.success) return undefined;
  const usage =
    carrier.data.response?.usage ??
    carrier.data.message?.usage ??
    carrier.data.usage;
  if (!usage) return undefined;
  if (
    usage.cache_read_input_tokens != null ||
    usage.cache_creation_input_tokens != null
  ) {
    // Anthropic reports uncached, cache-read, and cache-write input apart.
    const cachedTokens = usage.cache_read_input_tokens ?? 0;
    return {
      inputTokens:
        usage.input_tokens +
        cachedTokens +
        (usage.cache_creation_input_tokens ?? 0),
      cachedTokens,
    };
  }
  // OpenAI's input_tokens already includes cached tokens.
  return {
    inputTokens: usage.input_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

/** Reads the last reported usage from an SSE (or plain JSON) response body. */
async function readReportedUsage(
  body: ReadableStream<Uint8Array>,
): Promise<ReportedUsage | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let usage: ReportedUsage | undefined;
  let pending = "";
  let whole: string | undefined = "";
  const consider = (line: string) => {
    if (!line.startsWith("data:") || !line.includes('"usage"')) return;
    usage = usageFromJson(line.slice(5).trim()) ?? usage;
  };
  for (;;) {
    const { done, value: bytes } = await reader.read();
    if (done) break;
    const value = decoder.decode(bytes, { stream: true });
    if (whole !== undefined) {
      whole += value;
      if (whole.length > 1_000_000 || whole.trimStart().startsWith("data:")) {
        whole = undefined;
      }
    }
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) consider(line.trimEnd());
  }
  consider(pending.trimEnd());
  if (!usage && whole?.trimStart().startsWith("{")) {
    usage = usageFromJson(whole);
  }
  return usage;
}

type PendingCall = {
  model?: string;
  sections: ContextSections;
  usage?: ReportedUsage;
};

function finishCall(pending: PendingCall): ContextCall {
  const inputTokens =
    pending.usage?.inputTokens ??
    Math.ceil(sectionTotal(pending.sections) / CHARS_PER_ESTIMATED_TOKEN);
  const call: ContextCall = {
    inputTokens,
    cachedTokens: pending.usage?.cachedTokens ?? 0,
    estimated: !pending.usage,
    sections: scaleContextSections(pending.sections, inputTokens),
  };
  if (pending.model) call.model = pending.model;
  return call;
}

export type ContextRecorder = ReturnType<typeof createContextRecorder>;

/**
 * In-isolate buffer of measured calls, keyed by scope (the Durable Object id)
 * because several agent instances can share one isolate. Bounded so an
 * instance that never drains cannot grow memory without limit.
 */
export function createContextRecorder() {
  const scopes = new Map<string, PendingCall[]>();
  const inflight = new Set<Promise<void>>();
  return {
    record(
      scope: string,
      call: PendingCall,
      usage: Promise<ReportedUsage | undefined>,
    ) {
      const calls = scopes.get(scope) ?? [];
      scopes.delete(scope);
      scopes.set(scope, calls);
      calls.push(call);
      if (calls.length > MAX_CALLS_PER_SCOPE) calls.shift();
      while (scopes.size > MAX_SCOPES) {
        const oldest = scopes.keys().next().value;
        if (oldest === undefined) break;
        scopes.delete(oldest);
      }
      const settle: Promise<void> = usage
        .then((reported) => {
          call.usage = reported;
        })
        .catch(() => undefined)
        .finally(() => inflight.delete(settle));
      inflight.add(settle);
    },
    /** Resolves once every in-flight usage read has finished. */
    async settled() {
      await Promise.all(inflight);
    },
    /** Drains the scope's calls, in request order. */
    take(scope: string): ContextBreakdown | undefined {
      const calls = scopes.get(scope);
      scopes.delete(scope);
      if (!calls?.length) return undefined;
      return { v: 1, calls: calls.map(finishCall) };
    },
  };
}

/**
 * Wraps a provider SDK fetch so each successful model call is measured and
 * its reported usage read from a tee of the response stream.
 */
export function withContextCapture(
  fetchFn: typeof fetch,
  options: { recorder: ContextRecorder; scope: () => string },
): typeof fetch {
  return async (input, init) => {
    const text = z.string().safeParse(init?.body);
    const request = text.success ? parseModelRequest(text.data) : undefined;
    const response = await fetchFn(input, init);
    if (!response.ok || !request) return response;
    let call: PendingCall;
    let scope: string;
    try {
      call = { sections: measureParsed(request) };
      if (request.body.model) call.model = request.body.model;
      scope = options.scope();
    } catch {
      return response;
    }
    if (!response.body) {
      options.recorder.record(scope, call, Promise.resolve(undefined));
      return response;
    }
    const [forCaller, forUsage] = response.body.tee();
    options.recorder.record(scope, call, readReportedUsage(forUsage));
    return new Response(forCaller, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

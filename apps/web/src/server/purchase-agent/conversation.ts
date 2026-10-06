import type {
  AgentConversation,
  AgentConversationMessage,
  AgentConversationPart,
  AgentConversationSettlement,
} from "@cubby/schemas/agent-conversation";
import type { ContextBreakdown } from "@cubby/schemas/context-breakdown";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  ToolResultEntry,
  UserEntry,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import { parseSignal } from "./signals";

type Projection = {
  entries: readonly EntryRecord[];
  /** False before the first dispatch reached this agent. */
  present?: boolean;
  running: boolean;
  settlements: readonly AgentConversationSettlement[];
  contextCalls: ReadonlyMap<string, ContextBreakdown>;
  /** The in-flight assistant partial, committed at most every 100 ms. */
  partial?: AssistantMessage;
};

const jsonText = z
  .string()
  .transform((text, ctx) => {
    try {
      return z.json().parse(JSON.parse(text));
    } catch {
      ctx.addIssue({ code: "custom", message: "not JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.json());

const timeOf = (timestamp: number) => new Date(timestamp).toISOString();

function contentParts(
  content: UserMessage["content"] | (TextContent | ImageContent)[],
): AgentConversationPart[] {
  if (!Array.isArray(content)) return [{ type: "text", text: content }];
  return content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "file", mediaType: block.mimeType },
  );
}

/** A tool result as the transcript shows it: JSON when the text is JSON. */
function toolOutput(result: ToolResultMessage) {
  const text = result.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const parsed = jsonText.safeParse(text);
  return parsed.success ? parsed.data : text;
}

function userMessage(
  entry: EntryRecord,
  message: UserMessage,
): AgentConversationMessage {
  const base = {
    id: String(entry.id),
    createdAt: timeOf(message.timestamp),
    display: timeOf(message.timestamp),
  };
  const text = Array.isArray(message.content) ? "" : message.content;
  const signal = parseSignal(text);
  if (signal) {
    const { body, ...fields } = signal;
    return {
      ...base,
      role: "signal",
      purpose: "signal",
      signal: fields,
      parts: [{ type: "text", text: body }],
    };
  }
  return {
    ...base,
    role: "user",
    purpose: "member",
    parts: contentParts(message.content),
  };
}

function assistantMessage(
  id: string,
  message: AssistantMessage,
  results: ReadonlyMap<string, ToolResultMessage>,
  contextCalls: ReadonlyMap<string, ContextBreakdown>,
): AgentConversationMessage {
  const parts = message.content.map((block): AgentConversationPart => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "thinking")
      return { type: "reasoning", text: block.redacted ? "" : block.thinking };
    const result = results.get(block.id);
    const part = {
      type: "tool" as const,
      toolCallId: block.id,
      toolName: block.name,
      input: z.json().parse(block.arguments),
    };
    if (!result) return { ...part, state: "input-available" };
    const durationMs = Math.max(0, result.timestamp - message.timestamp);
    if (result.isError)
      return {
        ...part,
        state: "output-error",
        errorText: String(toolOutput(result)),
        durationMs,
      };
    return {
      ...part,
      state: "output-available",
      output: toolOutput(result),
      durationMs,
    };
  });
  const breakdown = message.responseId
    ? contextCalls.get(message.responseId)
    : undefined;
  const metadata: NonNullable<AgentConversationMessage["metadata"]> = {
    model: message.model,
    usage: {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite,
    },
  };
  if (breakdown) metadata.contextBreakdown = breakdown;
  return {
    id,
    role: "assistant",
    purpose: "coordinator",
    createdAt: timeOf(message.timestamp),
    display: timeOf(message.timestamp),
    metadata,
    parts,
  };
}

/**
 * The durable transcript as the run page reads it. Tool results join their
 * calls instead of standing as rows of their own; reset and system entries are
 * bookkeeping and stay out.
 */
export function projectConversation({
  entries,
  present = true,
  running,
  settlements,
  contextCalls,
  partial,
}: Projection): AgentConversation {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    const [message] = entry.model ?? [];
    if (ToolResultEntry.is(entry) && message?.role === "toolResult")
      results.set(message.toolCallId, message);
  }
  const messages: AgentConversationMessage[] = [];
  for (const entry of entries) {
    const [message] = entry.model ?? [];
    if (!message) continue;
    if (UserEntry.is(entry) && message.role === "user")
      messages.push(userMessage(entry, message));
    else if (CompactionEntry.is(entry) && message.role === "user")
      messages.push({
        id: String(entry.id),
        role: "signal",
        purpose: "signal",
        createdAt: timeOf(message.timestamp),
        display: timeOf(message.timestamp),
        signal: { type: "compaction" },
        parts: [],
      });
    else if (AssistantEntry.is(entry) && message.role === "assistant")
      messages.push(
        assistantMessage(String(entry.id), message, results, contextCalls),
      );
  }
  if (partial)
    messages.push(assistantMessage("live", partial, results, contextCalls));
  return {
    status: !present ? "absent" : running ? "running" : "idle",
    messages,
    settlements: [...settlements],
  };
}

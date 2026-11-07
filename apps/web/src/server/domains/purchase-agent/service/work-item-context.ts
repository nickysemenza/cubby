import type { ImportRunAgentToolName } from "@cubby/schemas/import-run-agent";
import { EXTRACT_ORDER_TOOL } from "@cubby/schemas/import-run-agent";
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

const CLAIM: ImportRunAgentToolName = "claim_next_import_work";

const continuation = z.object({
  kind: z.literal("commit_result"),
  nextWork: z.object({ kind: z.enum(["email", "none", "stopped"]) }),
});

/**
 * A request's messages without earlier work items: everything from the first
 * claim up to the latest claim is dropped except user messages (kickoff,
 * resume, member input) and system messages (pi records tool-list and
 * instruction deltas there once and never resends them). Durable records are the only memory between work
 * items; the stored transcript keeps every item for the Run page.
 */
export function currentWorkItemMessages(
  messages: readonly Message[],
): readonly Message[] {
  const continued = new Set(
    messages.flatMap((message) => {
      if (
        message.role !== "toolResult" ||
        message.toolName !== EXTRACT_ORDER_TOOL
      )
        return [];
      try {
        const text = message.content.find((part) => part.type === "text");
        return text?.type === "text" &&
          continuation.safeParse(JSON.parse(text.text)).success
          ? [message.toolCallId]
          : [];
      } catch {
        // SILENT: an unreadable continuation cannot discard earlier evidence.
        return [];
      }
    }),
  );
  const claims = (message: Message) =>
    message.role === "assistant" &&
    message.content.some(
      (block) =>
        block.type === "toolCall" &&
        (block.name === CLAIM || continued.has(block.id)),
    );
  const first = messages.findIndex(claims);
  if (first === -1) return messages;
  const latest =
    messages.length - 1 - [...messages].reverse().findIndex(claims);
  if (first === latest) return messages;
  return [
    ...messages.slice(0, first),
    ...messages
      .slice(first, latest)
      .filter(
        (message) => message.role === "user" || message.role === "system",
      ),
    ...messages.slice(latest),
  ];
}

const PHOTO_READ = "mcp__cubby__photo_run_read";
const PHOTO_WRITE = "mcp__cubby__photo_run";
const photoPage = z.object({
  remaining: z.literal(true),
  images: z.array(z.object({ id: z.string() })),
  boundaryGroup: z.unknown(),
});
const photoAcknowledgement = z.object({
  savedGroupKeys: z.array(z.string()),
});

function toolValue<T>(message: Message, schema: z.ZodType<T>): T | undefined {
  if (message.role !== "toolResult" || message.isError) return undefined;
  const text = message.content.find((part) => part.type === "text");
  try {
    return text?.type === "text"
      ? schema.safeParse(JSON.parse(text.text)).data
      : undefined;
  } catch {
    // SILENT: truncated or legacy output cannot establish a durable checkpoint.
    return undefined;
  }
}

/**
 * Photo decisions and the pending boundary live in proposals, not accumulated
 * reads. Publication closes a page; the next request reloads remaining photos
 * and its boundary. This projection never mutates pi's evidence transcript.
 */
export function currentPhotoWorkItemMessages(
  messages: readonly Message[],
): readonly Message[] {
  const calls = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") calls.set(block.id, index);
    }
  }
  let start: number | undefined;
  let pageCallId: string | undefined;
  let published = false;
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    if (message.toolName === PHOTO_READ && toolValue(message, photoPage)) {
      start = calls.get(message.toolCallId);
      pageCallId = message.toolCallId;
      published = false;
    }
    if (
      message.toolName === PHOTO_WRITE &&
      toolValue(message, photoAcknowledgement)
    ) {
      start = calls.get(message.toolCallId);
      published = true;
    }
  }
  const persistent = messages.filter(
    (message) => message.role === "user" || message.role === "system",
  );
  if (start === undefined || published) {
    return [
      ...persistent,
      {
        role: "user",
        timestamp: 0,
        content:
          "Reload durable photo grouping progress before further work: call photo_run_read run_context with remaining: true and no cursor. It returns only uncovered photos and the saved mutable boundary group. Keep member and settled decisions unchanged. Earlier tool evidence remains in the Run transcript.",
      },
    ];
  }
  const current = [
    ...messages
      .slice(0, start)
      .filter(
        (message) => message.role === "user" || message.role === "system",
      ),
    ...messages.slice(start),
  ];
  if (new TextEncoder().encode(JSON.stringify(current)).byteLength <= 96_000)
    return current;
  const latest = [...messages]
    .reverse()
    .find((message) => message.role === "toolResult");
  const keep = new Set([
    pageCallId,
    latest?.role === "toolResult" ? latest.toolCallId : undefined,
  ]);
  // Candidate reads are unpublished reasoning. Retain complete exchanges for
  // this page and the latest lookup; saved decisions reload from proposals.
  return [
    ...messages.flatMap((message): Message[] => {
      if (message.role === "user" || message.role === "system")
        return [message];
      if (message.role === "toolResult")
        return keep.has(message.toolCallId) ? [message] : [];
      if (message.role !== "assistant") return [];
      const content = message.content.filter(
        (part) => part.type === "toolCall" && keep.has(part.id),
      );
      return content.length ? [{ ...message, content }] : [];
    }),
    {
      role: "user",
      timestamp: 0,
      content:
        "The current photo page and latest complete lookup are retained; earlier unpublished lookups were removed to stay within the model budget. Publish the supported item now with a durable boundary when needed, then reload remaining photos. Do not reconstruct earlier speculative choices from memory.",
    },
  ];
}

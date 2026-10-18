import type { ImportRunAgentToolName } from "@cubby/schemas/import-run-agent";
import type { Message } from "@earendil-works/pi-ai";

const CLAIM: ImportRunAgentToolName = "claim_next_import_work";

const claims = (message: Message) =>
  message.role === "assistant" &&
  message.content.some(
    (block) => block.type === "toolCall" && block.name === CLAIM,
  );

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

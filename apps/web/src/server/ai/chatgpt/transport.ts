import { z } from "zod";

const item = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
});
const requestSchema = z.looseObject({
  input: z.array(item),
  tools: z.array(item).optional(),
  reasoning: z.looseObject({}).optional(),
});
const configurationUpdate = z.looseObject({
  type: z.literal("configuration_update"),
  reasoning: z.looseObject({ effort: z.string() }),
});
const unsupported = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/**
 * Where the `additional_tools` item sits in `input`: `leading` right after the
 * leading developer instructions, so the plan's prefix cache covers the tool
 * block; `trailing` (the original, verified order) after the conversation.
 */
export type ChatGptToolPlacement = "leading" | "trailing";

/** SIWC's direct route accepts client tools through additional_tools input. */
export function chatGptRequest(
  body: unknown,
  model: string,
  placement: ChatGptToolPlacement = "leading",
) {
  const parsed = requestSchema.parse(body);
  const { tools, ...rest } = parsed;
  for (const key of unsupported) delete rest[key];
  // pi-ai carries effort for mid-conversation-effort models as
  // `configuration_update` input items, recognizing plan tokens only by their
  // direct OpenAI base URL. Subscription sharing refuses those items with
  // `subscription_sharing_unsupported_capability`; the latest one is the
  // request's effort.
  let effort: string | undefined;
  const input = parsed.input.flatMap((entry) => {
    const update = configurationUpdate.safeParse(entry);
    if (update.success) {
      effort = update.data.reasoning.effort;
      return [];
    }
    return [entry.role === "system" ? { ...entry, role: "developer" } : entry];
  });
  if (effort) rest.reasoning = { ...parsed.reasoning, effort };
  const clientTools =
    tools?.filter(
      (tool) => tool.type === "function" || tool.type === "custom",
    ) ?? [];
  const hostedTools =
    tools?.filter(
      (tool) => tool.type !== "function" && tool.type !== "custom",
    ) ?? [];
  for (const tool of hostedTools) {
    if (tool.type !== "web_search" && tool.type !== "web_search_preview") {
      throw new Error(`ChatGPT plan usage does not support ${tool.type}`);
    }
  }
  if (clientTools.length) {
    const block = {
      type: "additional_tools",
      role: "developer",
      tools: clientTools,
    };
    // The prefix cache covers only the bytes before the first item that
    // changes, and every coordinator turn appends conversation items: a
    // trailing tool block (~20k tokens of Mail import schemas) is re-read
    // uncached on every call.
    const firstTurn = input.findIndex((entry) => entry.role !== "developer");
    if (placement === "trailing" || firstTurn < 0) input.push(block);
    else input.splice(firstTurn, 0, block);
  }
  const result: z.infer<typeof requestSchema> = {
    ...rest,
    model,
    input,
    store: false,
    stream: true,
  };
  if (hostedTools.length) result.tools = hostedTools;
  return result;
}

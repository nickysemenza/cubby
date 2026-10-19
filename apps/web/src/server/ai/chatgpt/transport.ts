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

const breakpoint = { mode: "explicit" } as const;
const toolResult = z.looseObject({
  type: z.literal("function_call_output"),
  output: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
});

/** Mark a tool result's last text block as a cache breakpoint. */
function withBreakpoint(entry: z.infer<typeof item>): z.infer<typeof item> {
  const result = toolResult.safeParse(entry);
  if (!result.success) return entry;
  const { output } = result.data;
  if (typeof output === "string")
    return {
      ...result.data,
      output: [
        {
          type: "input_text",
          text: output,
          prompt_cache_breakpoint: breakpoint,
        },
      ],
    };
  const last = output.at(-1);
  if (last?.type !== "input_text") return entry;
  return {
    ...result.data,
    output: [
      ...output.slice(0, -1),
      { ...last, prompt_cache_breakpoint: breakpoint },
    ],
  };
}

/**
 * SIWC's direct route accepts client tools through additional_tools input.
 * `breakpoints` marks each tool result as an explicit prompt-cache breakpoint:
 * the plan's implicit caching rarely reused a Run's growing conversation (5.6%
 * of Sol's plan input read from cache, against nearly all of an identical
 * request on the paid API).
 */
export function chatGptRequest(
  body: unknown,
  model: string,
  { breakpoints = true }: { breakpoints?: boolean } = {},
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
    const item =
      entry.role === "system" ? { ...entry, role: "developer" } : entry;
    return [breakpoints ? withBreakpoint(item) : item];
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
    // changes, and every coordinator turn appends conversation items: the tool
    // block (~10k tokens of Mail import schemas) follows the leading developer
    // instructions so it is read from cache, never re-read after each turn.
    const firstTurn = input.findIndex((entry) => entry.role !== "developer");
    if (firstTurn < 0) input.push(block);
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

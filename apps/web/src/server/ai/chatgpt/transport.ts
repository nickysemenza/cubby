import { z } from "zod";

const item = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
});
const requestSchema = z.looseObject({
  input: z.array(item),
  tools: z.array(item).optional(),
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

/** SIWC's direct route accepts client tools through additional_tools input. */
export function chatGptRequest(body: unknown, model: string) {
  const parsed = requestSchema.parse(body);
  const { tools, ...rest } = parsed;
  for (const key of unsupported) delete rest[key];
  const input = parsed.input.map((entry) =>
    entry.role === "system" ? { ...entry, role: "developer" } : entry,
  );
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
  if (clientTools.length)
    input.push({
      type: "additional_tools",
      role: "developer",
      tools: clientTools,
    });
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

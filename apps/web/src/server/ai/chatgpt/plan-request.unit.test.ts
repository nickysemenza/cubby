import { cubbyPiProviders } from "@cubby/shared/ai/pi-providers";
import { createModels } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { z } from "zod";

import { chatGptRequest } from "./transport";

// The plan's own refusal lists what subscription sharing accepts: "text, image,
// and file messages, item references, additional tools, compaction summaries,
// reasoning items, Web Search call items, developer function and custom tool
// call items, and programmatic tool calling items".
const planInputItem = z.union([
  z.looseObject({ type: z.literal("message").optional(), role: z.string() }),
  z.looseObject({
    type: z.enum([
      "item_reference",
      "additional_tools",
      "compaction",
      "reasoning",
      "web_search_call",
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
    ]),
  }),
]);

const completed = () =>
  new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

// Regression: pi-ai carried reasoning effort as a `configuration_update` input
// item, which the plan refuses with subscription_sharing_unsupported_capability.
it.each(["gpt-6-sol", "gpt-6-luna"] as const)(
  "sends %s a plan request with only input items subscription sharing accepts",
  async (id) => {
    const sent: unknown[] = [];
    const models = createModels();
    for (const provider of cubbyPiProviders(() => async (_input, init) => {
      sent.push(chatGptRequest(JSON.parse(String(init?.body)), id));
      return completed();
    }))
      models.setProvider(provider);
    const model = models.getModel("openai", id);
    if (!model) throw new Error(`Missing ${id}`);
    const response = await models.complete(
      model,
      {
        systemPrompt: "Answer with the respond tool.",
        tools: [
          {
            name: "respond",
            description: "Return the final structured answer.",
            parameters: { type: "object", properties: {} },
          },
        ],
        // A prior coordinator turn adds a per-turn effort update.
        messages: [
          { role: "user", content: "Synthetic question", timestamp: 1 },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_synthetic|fc_synthetic",
                name: "respond",
                arguments: {},
              },
            ],
            api: model.api,
            provider: model.provider,
            model: model.id,
            providerThinkingLevel: "high",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call_synthetic|fc_synthetic",
            toolName: "respond",
            content: [{ type: "text", text: "Synthetic result" }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
      {
        reasoningEffort: "low",
        toolChoice: { type: "function", name: "respond" },
      },
    );
    expect(response.errorMessage).toBeUndefined();
    expect(sent).toHaveLength(1);
    const { input, reasoning } = z
      .object({
        input: z.array(z.looseObject({ type: z.string().optional() })),
        reasoning: z.looseObject({ effort: z.string() }),
      })
      .parse(sent[0]);
    expect(
      input.filter((item) => !planInputItem.safeParse(item).success),
    ).toEqual([]);
    // pi-ai pins reasoning.effort while updates carry the requested level.
    expect(reasoning.effort).toBe("low");
  },
);

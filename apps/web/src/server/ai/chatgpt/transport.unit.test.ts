import { describe, expect, it } from "vitest";

import { chatGptRequest } from "./transport";

// Regressions: forbidden SDK fields, unsupported ungrouped tools, system
// messages, lost tool results, and a different model leaking into billing.
describe("ChatGPT plan Responses transport", () => {
  it("adapts SDK requests without losing conversation or tool choice", () => {
    const request = chatGptRequest(
      {
        model: "api-model",
        store: true,
        stream: false,
        max_output_tokens: 500,
        temperature: 0.2,
        metadata: { source: "test" },
        previous_response_id: "previous",
        reasoning: { effort: "low" },
        input: [
          {
            type: "message",
            role: "system",
            content: "Use the supplied evidence.",
          },
          { role: "user", content: "Example request" },
          {
            type: "function_call_output",
            call_id: "call_example",
            output: "Example result",
          },
        ],
        tools: [
          { type: "function", name: "respond", parameters: { type: "object" } },
        ],
        tool_choice: { type: "function", name: "respond" },
      },
      "plan-model",
    );
    expect(request).toEqual({
      model: "plan-model",
      store: false,
      stream: true,
      reasoning: { effort: "low" },
      input: [
        {
          type: "message",
          role: "developer",
          content: "Use the supplied evidence.",
        },
        { role: "user", content: "Example request" },
        {
          type: "function_call_output",
          call_id: "call_example",
          output: "Example result",
        },
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "function",
              name: "respond",
              parameters: { type: "object" },
            },
          ],
        },
      ],
      tool_choice: { type: "function", name: "respond" },
    });
  });

  it("rejects hosted tools rather than pretending they are supported", () => {
    expect(() =>
      chatGptRequest(
        { input: [], tools: [{ type: "tool_search" }] },
        "plan-model",
      ),
    ).toThrow("tool_search");
  });
});

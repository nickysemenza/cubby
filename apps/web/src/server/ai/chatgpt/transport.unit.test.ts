import { describe, expect, it } from "vitest";

import { chatGptRequest } from "./transport";

// Regressions: forbidden SDK fields, unsupported ungrouped tools, system
// messages, lost tool results, a different model leaking into billing, and
// conversation items preceding the tool block (the plan's prefix cache then
// never covers the tools, ~20k tokens per Mail import call).
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
        { role: "user", content: "Example request" },
        {
          type: "function_call_output",
          call_id: "call_example",
          output: "Example result",
        },
      ],
      tool_choice: { type: "function", name: "respond" },
    });
  });

  it("keeps the tool block in the cached prefix, or trailing on request", () => {
    const body = {
      input: [
        { role: "system", content: "Frame" },
        { role: "developer", content: "Workflow" },
        { role: "user", content: "Synthetic Email" },
        { role: "developer", content: "Late reminder" },
      ],
      tools: [{ type: "function", name: "claim" }],
    };
    const order = (placement?: "leading" | "trailing") =>
      chatGptRequest(body, "plan-model", placement).input.map(
        (entry) => entry.type ?? entry.role,
      );
    expect(order()).toEqual([
      "developer",
      "developer",
      "additional_tools",
      "user",
      "developer",
    ]);
    expect(order("trailing")).toEqual([
      "developer",
      "developer",
      "user",
      "developer",
      "additional_tools",
    ]);
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

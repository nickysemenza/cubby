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
      { breakpoints: false },
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

  it("keeps the tool block in the cached prefix", () => {
    const body = {
      input: [
        { role: "system", content: "Frame" },
        { role: "developer", content: "Workflow" },
        { role: "user", content: "Synthetic Email" },
        { role: "developer", content: "Late reminder" },
      ],
      tools: [{ type: "function", name: "claim" }],
    };
    expect(
      chatGptRequest(body, "plan-model").input.map(
        (entry) => entry.type ?? entry.role,
      ),
    ).toEqual([
      "developer",
      "developer",
      "additional_tools",
      "user",
      "developer",
    ]);
  });

  // The plan's implicit cache rarely reused a Run's growing conversation:
  // without a breakpoint on each tool result, every turn re-reads it uncached.
  it("marks each tool result as a cache breakpoint unless told not to", () => {
    const body = {
      input: [
        { role: "user", content: "Synthetic Email" },
        {
          type: "function_call",
          call_id: "c1",
          name: "claim",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "c1",
          output: '{"kind":"none"}',
        },
        {
          type: "function_call_output",
          call_id: "c2",
          output: [
            { type: "input_image", image_url: "https://example.test/a.png" },
            { type: "input_text", text: "Synthetic caption" },
          ],
        },
        {
          type: "function_call_output",
          call_id: "c3",
          output: [
            { type: "input_text", text: "Synthetic caption" },
            { type: "input_image", image_url: "https://example.test/b.png" },
          ],
        },
      ],
    };
    const [, , text, mixed, imageLast] = chatGptRequest(
      body,
      "plan-model",
    ).input;
    expect(text).toMatchObject({
      output: [
        {
          type: "input_text",
          text: '{"kind":"none"}',
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ],
    });
    expect(mixed).toMatchObject({
      output: [
        { type: "input_image" },
        { type: "input_text", prompt_cache_breakpoint: { mode: "explicit" } },
      ],
    });
    expect(imageLast).toMatchObject({
      output: [
        { type: "input_text", prompt_cache_breakpoint: { mode: "explicit" } },
        { type: "input_image" },
      ],
    });
    expect(
      chatGptRequest(body, "plan-model", { breakpoints: false }).input,
    ).toEqual(body.input);
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

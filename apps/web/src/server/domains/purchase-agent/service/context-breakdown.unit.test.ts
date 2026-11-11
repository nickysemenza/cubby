import { describe, expect, it } from "vitest";

import {
  createContextRecorder,
  scaleContextSections,
  withContextCapture,
  type ContextSections,
} from "./context-breakdown";

const total = (sections: ContextSections) =>
  sections.instructions +
  sections.agentToolSchemas +
  sections.mcpToolSchemas +
  sections.conversation +
  Object.values(sections.toolResults).reduce((sum, n) => sum + n, 0);

describe("scaleContextSections", () => {
  it("scales proportionally and sums exactly to the reported input tokens", () => {
    const scaled = scaleContextSections(
      {
        instructions: 3_333,
        agentToolSchemas: 1_111,
        mcpToolSchemas: 7_777,
        conversation: 2_222,
        toolResults: { a: 5_555, b: 1 },
      },
      150_001,
    );
    expect(total(scaled)).toBe(150_001);
    expect(scaled.mcpToolSchemas).toBeGreaterThan(scaled.toolResults.a ?? 0);
    expect(scaled.toolResults.a ?? 0).toBeGreaterThan(scaled.instructions);
    for (const value of [
      scaled.instructions,
      scaled.agentToolSchemas,
      scaled.mcpToolSchemas,
      scaled.conversation,
      ...Object.values(scaled.toolResults),
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("puts every token in conversation when nothing was measured", () => {
    const scaled = scaleContextSections(
      {
        instructions: 0,
        agentToolSchemas: 0,
        mcpToolSchemas: 0,
        conversation: 0,
        toolResults: {},
      },
      42,
    );
    expect(scaled.conversation).toBe(42);
    expect(total(scaled)).toBe(42);
  });
});

const sse = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

describe("withContextCapture", () => {
  const openAiBody = JSON.stringify({
    model: "gpt-6.1-sol",
    input: [
      { role: "developer", content: "x".repeat(600) },
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          { type: "function", name: "report_progress", parameters: {} },
          { type: "function", name: "mcp__cubby__entity_read", parameters: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "y".repeat(400) }],
      },
    ],
  });

  it("records reported OpenAI usage and leaves the response stream intact", async () => {
    const recorder = createContextRecorder();
    const stream = sse([
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.completed",
        response: {
          id: "r1",
          usage: {
            input_tokens: 1_000,
            input_tokens_details: { cached_tokens: 600 },
            output_tokens: 5,
          },
        },
      },
    ]);
    const captured = withContextCapture(
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
      { recorder, scope: () => "run-a" },
    );

    const response = await captured("https://example.invalid/responses", {
      method: "POST",
      body: openAiBody,
    });
    expect(await response.text()).toBe(stream);
    await recorder.settled();

    expect(recorder.take("run-b")).toBeUndefined();
    const breakdown = recorder.take("run-a");
    expect(breakdown?.calls).toHaveLength(1);
    const [call] = breakdown!.calls;
    expect(call).toMatchObject({
      model: "gpt-6.1-sol",
      inputTokens: 1_000,
      cachedTokens: 600,
      estimated: false,
    });
    expect(total(call!.sections)).toBe(1_000);
    expect(call!.sections.instructions).toBeGreaterThan(400);
    expect(call!.sections.agentToolSchemas).toBeGreaterThan(0);
    expect(call!.sections.mcpToolSchemas).toBeGreaterThan(0);
    expect(recorder.take("run-a")).toBeUndefined();
  });

  it("adds Anthropic cache reads and writes to input tokens", async () => {
    const recorder = createContextRecorder();
    const captured = withContextCapture(
      async () =>
        new Response(
          sse([
            {
              type: "message_start",
              message: {
                usage: {
                  input_tokens: 10,
                  cache_read_input_tokens: 800,
                  cache_creation_input_tokens: 190,
                },
              },
            },
            { type: "message_delta", usage: { output_tokens: 3 } },
          ]),
        ),
      { recorder, scope: () => "run-a" },
    );

    const response = await captured("https://example.invalid/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        system: "s",
        messages: [],
      }),
    });
    await response.text();
    await recorder.settled();

    const [call] = recorder.take("run-a")!.calls;
    expect(call).toMatchObject({ inputTokens: 1_000, cachedTokens: 800 });
    expect(total(call!.sections)).toBe(1_000);
  });

  it("falls back to a marked character estimate when usage never arrives", async () => {
    const recorder = createContextRecorder();
    const captured = withContextCapture(
      async () => new Response("data: [DONE]\n\n"),
      { recorder, scope: () => "run-a" },
    );
    await (
      await captured("https://example.invalid/responses", {
        method: "POST",
        body: openAiBody,
      })
    ).text();
    await recorder.settled();

    const [call] = recorder.take("run-a")!.calls;
    expect(call!.estimated).toBe(true);
    expect(call!.inputTokens).toBeGreaterThan(0);
    expect(total(call!.sections)).toBe(call!.inputTokens);
  });
});

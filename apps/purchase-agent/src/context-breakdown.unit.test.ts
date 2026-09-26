import { describe, expect, it } from "vitest";

import {
  IMAGE_CHAR_WEIGHT,
  createContextRecorder,
  measureRequestContext,
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

const tool = (name: string, description: string) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties: {} },
});

describe("measureRequestContext", () => {
  it("splits an OpenAI Responses body into sections and attributes tool results by name", () => {
    const sections = measureRequestContext(
      JSON.stringify({
        model: "gpt-6-sol",
        input: [
          { role: "developer", content: "x".repeat(500) },
          {
            role: "user",
            content: [{ type: "input_text", text: "y".repeat(40) }],
          },
          {
            type: "function_call",
            call_id: "call_a",
            name: "mcp__cubby__get_photo_run_context",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_a",
            output: "z".repeat(3_000),
          },
          {
            type: "function_call",
            call_id: "call_b",
            name: "report_agent_progress",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_b",
            output: [
              { type: "input_text", text: "ok" },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${"A".repeat(200_000)}`,
              },
            ],
          },
          { type: "function_call_output", call_id: "orphan", output: "q" },
        ],
        tools: [
          tool("mcp__cubby__get_photo_run_context", "d".repeat(900)),
          tool("mcp__cubby__entity", "d".repeat(900)),
          tool("report_agent_progress", "d".repeat(100)),
        ],
      }),
    );

    expect(sections.instructions).toBeGreaterThanOrEqual(500);
    expect(sections.instructions).toBeLessThan(600);
    expect(sections.mcpToolSchemas).toBeGreaterThan(
      sections.agentToolSchemas * 5,
    );
    expect(sections.agentToolSchemas).toBeGreaterThan(100);
    expect(sections.conversation).toBeGreaterThanOrEqual(40);
    expect(sections.conversation).toBeLessThan(500);
    expect(
      sections.toolResults["mcp__cubby__get_photo_run_context"],
    ).toBeGreaterThanOrEqual(3_000);
    // An image counts as a fixed weight, never its base64 length.
    expect(sections.toolResults["report_agent_progress"]).toBeGreaterThan(
      IMAGE_CHAR_WEIGHT,
    );
    expect(sections.toolResults["report_agent_progress"]).toBeLessThan(
      IMAGE_CHAR_WEIGHT + 200,
    );
    expect(sections.toolResults["unknown"]).toBeGreaterThan(0);
  });

  it("reads the top-level Responses instructions field", () => {
    const sections = measureRequestContext(
      JSON.stringify({
        instructions: "i".repeat(200),
        input: [],
      }),
    );
    // Serialized size: the string plus its quotes.
    expect(sections.instructions).toBe(202);
  });

  it("splits an Anthropic Messages body into sections and attributes tool results by name", () => {
    const sections = measureRequestContext(
      JSON.stringify({
        model: "claude-sonnet-5",
        system: [{ type: "text", text: "s".repeat(700) }],
        tools: [
          {
            name: "mcp__cubby__entity",
            description: "d".repeat(400),
            input_schema: {},
          },
          { name: "finish_run", description: "d".repeat(50), input_schema: {} },
        ],
        messages: [
          { role: "user", content: "hello there" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "mcp__cubby__entity",
                input: { action: "list" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "text", text: "r".repeat(1_200) }],
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "B".repeat(90_000),
                },
              },
            ],
          },
        ],
      }),
    );

    expect(sections.instructions).toBeGreaterThanOrEqual(700);
    expect(sections.instructions).toBeLessThan(800);
    expect(sections.mcpToolSchemas).toBeGreaterThan(400);
    expect(sections.agentToolSchemas).toBeGreaterThan(50);
    expect(sections.agentToolSchemas).toBeLessThan(sections.mcpToolSchemas);
    expect(sections.toolResults["mcp__cubby__entity"]).toBeGreaterThanOrEqual(
      1_200,
    );
    expect(sections.toolResults["mcp__cubby__entity"]).toBeLessThan(1_400);
    expect(sections.conversation).toBeGreaterThan(IMAGE_CHAR_WEIGHT);
    expect(sections.conversation).toBeLessThan(IMAGE_CHAR_WEIGHT + 300);
  });
});

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
    model: "gpt-6-sol",
    input: [
      { role: "developer", content: "x".repeat(600) },
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
      model: "gpt-6-sol",
      inputTokens: 1_000,
      cachedTokens: 600,
      estimated: false,
    });
    expect(total(call!.sections)).toBe(1_000);
    expect(call!.sections.instructions).toBeGreaterThan(550);
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
        model: "claude-sonnet-5",
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

import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { creditRefusedResponse } from "./gateway-request";
import {
  cubbyPiProviders,
  fundedCubbyPiProviders,
  piTokenUsage,
} from "./pi-providers";

const responsesBody = z.object({
  input: z.array(z.looseObject({ content: z.unknown().optional() })),
});

// A rejected generation may contain partial tool calls. Never publish those
// before choosing a successful funding attempt, or the fallback can repeat writes.
it("restarts a credit-refused generation on the subscription with its actual model", async () => {
  const attempts: string[] = [];
  const models = createModels();
  for (const provider of fundedCubbyPiProviders(
    (route, _unbilled, funding) => async () => {
      attempts.push(`${route}:${funding}`);
      if (funding === "subscriber_credit")
        return Response.json(
          {
            error: {
              type: "invalid_request_error",
              message:
                "Your credit balance is too low to access the Anthropic API.",
            },
          },
          { status: 400 },
        );
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic-response", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  ))
    models.setProvider(provider);
  const model = models.getModel("anthropic", "claude-opus-5-5");
  if (!model) throw new Error("Missing Opus");
  const response = await models.completeSimple(
    model,
    { messages: [] },
    { maxTokens: 512 },
  );
  expect(response.errorMessage).toBeUndefined();
  expect(response.model).toBe("gpt-6-sol");
  expect(attempts).toEqual([
    "anthropic:subscriber_credit",
    "openai:subscription",
  ]);
});

// Regression: a Console-refused credit key was re-tried on every request. The
// egress Durable Object now answers for it; the ladder must treat that answer
// as the provider's own refusal and move to the plan.
it("advances past a credit attempt the egress object refuses from its recorded refusal", async () => {
  const attempts: string[] = [];
  const models = createModels();
  for (const provider of fundedCubbyPiProviders(
    (route, _unbilled, funding) => async () => {
      attempts.push(`${route}:${funding}`);
      if (funding === "subscriber_credit")
        return creditRefusedResponse({
          until: Date.parse("2099-11-01T00:00:00Z"),
          reason:
            '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2099-11-01 at 00:00 UTC."}}',
        });
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic-response", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  ))
    models.setProvider(provider);
  const model = models.getModel("anthropic", "claude-opus-5-5");
  if (!model) throw new Error("Missing Opus");
  const response = await models.completeSimple(
    model,
    { messages: [] },
    { maxTokens: 512 },
  );
  expect(response.errorMessage).toBeUndefined();
  expect(response.model).toBe("gpt-6-sol");
  expect(attempts).toEqual([
    "anthropic:subscriber_credit",
    "openai:subscription",
  ]);
});

// A coordinator whose manifest names a cheaper primary (or escalates to
// another model) must be answered by that model: the household ladder alone
// always led with Opus, silently replacing the requested model.
describe("a ladder that leads with the requested model", () => {
  const credit = {
    error: {
      type: "invalid_request_error",
      message: "Your credit balance is too low to access the Anthropic API.",
    },
  };
  it.each([
    ["claude-haiku-5-5", "anthropic:subscriber_credit:claude-haiku-5-5"],
    ["claude-sonnet-5-5", "anthropic:subscriber_credit:claude-sonnet-5-5"],
  ] as const)(
    "funds %s from the Claude credit first, then the household ladder",
    async (requested, first) => {
      const attempts: string[] = [];
      const models = createModels();
      for (const provider of fundedCubbyPiProviders(
        (route, _unbilled, funding) => async (_input, init) => {
          const body = z
            .object({ model: z.string() })
            .parse(JSON.parse(String(init?.body)));
          attempts.push(`${route}:${funding}:${body.model}`);
          if (funding === "subscriber_credit")
            return Response.json(credit, { status: 400 });
          return openAiCompleted();
        },
        undefined,
        { paid: true, leadWithRequested: true },
      ))
        models.setProvider(provider);
      const model = models.getModel("anthropic", requested);
      if (!model) throw new Error(`Missing ${requested}`);
      const response = await models.completeSimple(model, { messages: [] });
      expect(response.errorMessage).toBeUndefined();
      expect(attempts).toEqual([
        first,
        "anthropic:subscriber_credit:claude-opus-5-5",
        "openai:subscription:gpt-6-sol",
      ]);
    },
  );

  it("funds an OpenAI primary from the ChatGPT plan first", async () => {
    const attempts: string[] = [];
    const models = createModels();
    for (const provider of fundedCubbyPiProviders(
      (route, _unbilled, funding) => async (_input, init) => {
        const body = z
          .object({ model: z.string() })
          .parse(JSON.parse(String(init?.body)));
        attempts.push(`${route}:${funding}:${body.model}`);
        return openAiCompleted();
      },
      undefined,
      { paid: true, leadWithRequested: true },
    ))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-luna");
    if (!model) throw new Error("Missing Luna");
    const response = await models.completeSimple(model, { messages: [] });
    expect(response.model).toBe("gpt-6-luna");
    expect(attempts).toEqual(["openai:subscription:gpt-6-luna"]);
  });
});

/** The paid step answers on the plan's model through the gateway. */
const openAiCompleted = () =>
  new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic-paid", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

const syntheticAnthropicEvent = z.looseObject({ type: z.string() });
function anthropicStream(events: z.infer<typeof syntheticAnthropicEvent>[]) {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const anthropicStart = {
  type: "message_start",
  message: {
    id: "synthetic-message",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude-opus-5-5",
    stop_reason: null,
    usage: { input_tokens: 100, output_tokens: 0 },
  },
};
const anthropicDone = [
  anthropicStart,
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 10 },
  },
  { type: "message_stop" },
];

it("records subscriber-credit cost separately and skips later funding on success", async () => {
  const attempts: string[] = [];
  const models = createModels();
  for (const provider of fundedCubbyPiProviders(
    (_route, _unbilled, funding) => async () => {
      attempts.push(String(funding));
      return anthropicStream(anthropicDone);
    },
  ))
    models.setProvider(provider);
  const model = models.getModel("anthropic", "claude-opus-5-5");
  if (!model) throw new Error("Missing Opus");
  const response = await models.completeSimple(model, { messages: [] });
  expect(response.errorMessage).toBeUndefined();
  expect(attempts).toEqual(["subscriber_credit"]);
  expect(piTokenUsage(response)).toMatchObject({
    chargedCost: 0,
    costEvidence: { billingReason: "subscriber_credit" },
  });
  expect(piTokenUsage(response).standardCost).toBeGreaterThan(0);
});

it("discards a partial tool call before falling through both included funding routes", async () => {
  const attempts: string[] = [];
  const refused: string[] = [];
  const models = createModels();
  for (const provider of fundedCubbyPiProviders(
    (_route, _unbilled, funding) => async () => {
      attempts.push(String(funding));
      if (funding === "subscriber_credit")
        return anthropicStream([
          anthropicStart,
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "synthetic-call",
              name: "save",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"value":"partial"}',
            },
          },
          {
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "enforced_spend_limit_reached",
            },
          },
        ]);
      if (funding === "subscription")
        return Response.json(
          { error: { code: "usage_limit_reached" } },
          { status: 429 },
        );
      return openAiCompleted();
    },
    async (message) => {
      refused.push(message.model);
    },
  ))
    models.setProvider(provider);
  const model = models.getModel("anthropic", "claude-opus-5-5");
  if (!model) throw new Error("Missing Opus");
  const stream = models.streamSimple(model, { messages: [] });
  const emitted: string[] = [];
  for await (const event of stream) emitted.push(event.type);
  const result = await stream.result();
  expect(result.errorMessage).toBeUndefined();
  expect(attempts).toEqual(["subscriber_credit", "subscription", "paid"]);
  expect(refused).toEqual(["claude-opus-5-5", "gpt-6-sol"]);
  expect(emitted).not.toContain("toolcall_start");
  expect(piTokenUsage(result).costEvidence?.billingReason).toBe("standard");
});

it.each(["error", "response.failed"])(
  "restarts on a late subscription %s quota refusal",
  async (type) => {
    const attempts: string[] = [];
    const models = createModels();
    for (const provider of fundedCubbyPiProviders(
      (_route, _unbilled, funding) => async () => {
        attempts.push(String(funding));
        if (funding === "subscriber_credit")
          return Response.json(
            { error: { message: "Your credit balance is too low" } },
            { status: 400 },
          );
        if (funding === "subscription") {
          const error = {
            code: "usage_limit_reached",
            message: "Synthetic quota",
          };
          const event =
            type === "error"
              ? { type, ...error }
              : { type, response: { error } };
          return new Response(`data: ${JSON.stringify(event)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return openAiCompleted();
      },
    ))
      models.setProvider(provider);
    const model = models.getModel("anthropic", "claude-opus-5-5");
    if (!model) throw new Error("Missing Opus");
    const response = await models.completeSimple(model, { messages: [] });
    expect(response.errorMessage).toBeUndefined();
    expect(attempts).toEqual(["subscriber_credit", "subscription", "paid"]);
  },
);

// A request the plan cannot carry is a funding refusal, not a model error.
it.each([
  [true, ["subscriber_credit", "subscription", "paid"]],
  [false, ["subscriber_credit", "subscription"]],
] as const)(
  "advances past an unsupported plan request only when paid is allowed (paid=%s)",
  async (paid, expected) => {
    const attempts: string[] = [];
    const models = createModels();
    for (const provider of fundedCubbyPiProviders(
      (_route, _unbilled, funding) => async () => {
        attempts.push(String(funding));
        if (funding === "subscriber_credit")
          return Response.json(
            { error: { message: "Your credit balance is too low" } },
            { status: 400 },
          );
        if (funding === "subscription")
          return Response.json(
            {
              error: {
                type: "invalid_request_error",
                param: "input",
                code: "subscription_sharing_unsupported_capability",
              },
            },
            { status: 400 },
          );
        return openAiCompleted();
      },
      undefined,
      { paid },
    ))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-luna");
    if (!model) throw new Error("Missing Luna");
    const response = await models.completeSimple(model, { messages: [] });
    expect(attempts).toEqual(expected);
    expect(response.model).toBe("gpt-6-sol");
    expect(Boolean(response.errorMessage)).toBe(!paid);
  },
);

it("sends PDF user content and nested tool results as Anthropic documents", async () => {
  let body = "";
  const models = createModels();
  for (const provider of cubbyPiProviders(() => async (_input, init) => {
    body = String(init?.body);
    return anthropicStream(anthropicDone);
  }))
    models.setProvider(provider);
  const model = models.getModel("anthropic", "claude-opus-5-5");
  if (!model) throw new Error("Missing Opus");
  const pdf = {
    type: "image",
    data: "JVBERi0=",
    mimeType: "application/pdf",
  } as const;
  await models.completeSimple(model, {
    tools: [
      {
        name: "attachment",
        description: "Read a synthetic attachment",
        parameters: { type: "object", properties: {} },
      },
    ],
    messages: [
      { role: "user", content: [pdf], timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "synthetic-tool",
            name: "attachment",
            arguments: {},
          },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "toolUse",
        timestamp: 2,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "toolResult",
        toolCallId: "synthetic-tool",
        toolName: "attachment",
        content: [pdf],
        isError: false,
        timestamp: 3,
      },
    ],
  });
  const sent = JSON.parse(body);
  expect(sent.messages[0].content[0]).toMatchObject({
    type: "document",
    source: { media_type: "application/pdf" },
  });
  expect(body).not.toContain('"type":"image"');
  const result = sent.messages
    .flatMap((message: { content: { type: string }[] }) => message.content)
    .find((block: { type: string }) => block.type === "tool_result");
  expect(result.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "document" })]),
  );
});

// Structured runs force their respond tool on OpenAI; Opus always thinks and
// rejects a forced tool_choice (400), so the credit attempt asks with "auto".
it("relaxes a forced tool call to auto on the credit attempt", async () => {
  let body: unknown;
  const models = createModels();
  for (const provider of fundedCubbyPiProviders(
    () => async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("synthetic stop", { status: 401 });
    },
    undefined,
    { paid: false },
  ))
    models.setProvider(provider);
  const model = models.getModel("openai", "gpt-6-luna");
  if (!model) throw new Error("Missing Luna");
  await models.complete(
    model,
    {
      messages: [],
      tools: [
        {
          name: "respond",
          description: "Synthetic respond tool",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    // SAFETY: the OpenAI-shaped options structured runs pass to the ladder.
    {
      toolChoice: { type: "function", name: "respond" },
      reasoningEffort: "medium",
    } as never,
  );
  expect(body).toMatchObject({
    model: "claude-opus-5-5",
    tool_choice: { type: "auto" },
  });
});

describe("cubbyPiProviders OpenAI route", () => {
  // pi-ai's only binary content is an image, so a PDF receipt would reach
  // the Responses API as `input_image` with a PDF data URL, which it rejects;
  // a PDF must be an `input_file`.
  it("sends a PDF as an input file and leaves images as images", async () => {
    let body: unknown;
    const models = createModels();
    for (const provider of cubbyPiProviders(() => async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("synthetic refusal", { status: 400 });
    }))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-luna");
    if (!model) throw new Error("gpt-6-luna is not declared");
    await models.complete(model, {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: "JVBERi0=", mimeType: "application/pdf" },
            { type: "image", data: "iVBORw0=", mimeType: "image/png" },
            { type: "text", text: "Extract this synthetic receipt." },
          ],
          timestamp: Date.now(),
        },
      ],
    });
    const content = responsesBody
      .parse(body)
      .input.flatMap((item) =>
        Array.isArray(item.content) ? item.content : [],
      );
    expect(content).toContainEqual({
      type: "input_file",
      filename: "evidence.pdf",
      file_data: "data:application/pdf;base64,JVBERi0=",
    });
    expect(content).toContainEqual(
      expect.objectContaining({
        type: "input_image",
        image_url: "data:image/png;base64,iVBORw0=",
      }),
    );
    expect(JSON.stringify(content)).not.toContain(
      '"image_url":"data:application/pdf',
    );
  });
});

// A gateway cache HIT replays a stored answer the gateway does not bill, so
// charged cost stays zero while its comparison price and evidence survive.
describe("cubbyPiProviders cost normalization", () => {
  const completed = (headers: Record<string, string>) =>
    new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "example-response",
          status: "completed",
          output: [],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream", ...headers } },
    );

  async function costFor(headers: Record<string, string>) {
    const models = createModels();
    for (const provider of cubbyPiProviders(
      () => async () => completed(headers),
    ))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-sol");
    if (!model) throw new Error("gpt-6-sol is not declared");
    const message = await models.complete(model, { messages: [] });
    return {
      cost: message.usage.cost.total,
      standardCost: piTokenUsage(message).standardCost,
      input: message.usage.input,
    };
  }

  it("zeroes a gateway cache hit's cost but keeps its token evidence", async () => {
    expect(await costFor({ "cf-aig-cache-status": "HIT" })).toMatchObject({
      cost: 0,
      input: 100,
    });
    expect(
      (await costFor({ "cf-aig-cache-status": "HIT" })).standardCost,
    ).toBeGreaterThan(0);
  });

  it("keeps the catalog price on a cache miss", async () => {
    expect(
      (await costFor({ "cf-aig-cache-status": "MISS" })).cost,
    ).toBeGreaterThan(0);
  });
});

// An upstream failure can leave pi's initialized zero counts without a usage
// report. These are unknown, while a failed validation can retain billed tokens.
it("keeps failed calls without reported tokens unknown", () => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  expect(piTokenUsage({ stopReason: "error", usage })).toMatchObject({
    inputTokens: null,
    outputTokens: null,
  });
  expect(
    piTokenUsage({
      stopReason: "error",
      usage: { ...usage, input: 100, totalTokens: 100 },
    }),
  ).toMatchObject({ inputTokens: 100, outputTokens: 0 });
  expect(piTokenUsage({ stopReason: "stop", usage })).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
  });
});

// Incomplete output can contain plausible tool calls. Agent callers must never
// treat truncation as a successful turn; Rust's separate folding path retains it.
it("rejects an incomplete Responses turn before handing tools to the coordinator", async () => {
  const models = createModels();
  for (const provider of cubbyPiProviders(
    () => async () =>
      new Response(
        `data: ${JSON.stringify({
          type: "response.incomplete",
          response: {
            id: "synthetic-incomplete",
            status: "incomplete",
            output: [],
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  ))
    models.setProvider(provider);
  const model = models.getModel("openai", "gpt-6-sol");
  if (!model) throw new Error("Missing Sol");
  const stream = models.streamSimple(model, { messages: [] });
  const terminal: string[] = [];
  for await (const event of stream)
    if (event.type === "done" || event.type === "error")
      terminal.push(event.type);
  expect(terminal).toEqual(["error"]);
  expect(await stream.result()).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("incomplete"),
    usage: { output: 1 },
  });
});

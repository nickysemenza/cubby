import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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
      return anthropicStream(anthropicDone);
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
        return anthropicStream(anthropicDone);
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

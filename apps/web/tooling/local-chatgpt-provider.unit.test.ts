import { afterEach, expect, it, vi } from "vitest";

import agentEvalModel from "./agent-eval-model";
import { chatGptRequest } from "../src/server/ai/chatgpt/transport";

// A subscription acceptance request must not reach paid inference, leak the
// caller's key, lose Responses events, or outlive its cancellation/deadline.
const upstream = vi.fn<typeof fetch>();
afterEach(() => {
  vi.unstubAllGlobals();
  upstream.mockReset();
});

it("accepts the production subscription's additional_tools declaration without losing tools", async () => {
  const { subscriptionResponses } = await import("./local-chatgpt-provider");
  const doStream = vi.fn().mockResolvedValue({
    stream: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  });
  const request = chatGptRequest(
    {
      input: [{ role: "user", content: "Investigate the synthetic fan." }],
      tools: [
        {
          type: "function",
          name: "work_next",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    "gpt-6-sol",
  );
  const response = await subscriptionResponses(
    request,
    new AbortController().signal,
    () => ({ doStream }),
  );
  await response.text();
  expect(doStream.mock.lastCall?.[0]).toMatchObject({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "Investigate the synthetic fan." }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "work_next",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
});

it("routes subscription acceptance exclusively to its local transport", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(
    new Response(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
    ),
  );
  const env = {
    ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    AI_GATEWAY_API_KEY: "synthetic-paid-key",
    GATEWAY_ENVIRONMENT: "development" as const,
    SUBSCRIPTION_PROVIDER_URL: "http://127.0.0.1:43123",
  };
  const ctx = { waitUntil: () => undefined };
  await agentEvalModel.fetch(
    new Request("https://eval.test/configure", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }),
    }),
    env,
    ctx,
  );
  await agentEvalModel.fetch(
    new Request("https://eval.test/openai/responses", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-sdk-key" },
      body: JSON.stringify({ model: "gpt-6-luna", input: [], stream: true }),
    }),
    env,
    ctx,
  );
  const [url, init] = upstream.mock.lastCall ?? [];
  expect(String(url)).toBe("http://127.0.0.1:43123/responses");
  expect(new Headers(init?.headers).get("authorization")).toBeNull();
  expect(new Headers(init?.headers).get("cf-aig-authorization")).toBeNull();
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-6-sol" });
});

it("preserves full tool conversation and original Responses events", async () => {
  const { subscriptionResponses } = await import("./local-chatgpt-provider");
  const raw = {
    type: "response.completed",
    response: {
      id: "synthetic-response",
      usage: { input_tokens: 20, output_tokens: 3 },
    },
  };
  const doStream = vi.fn().mockResolvedValue({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "raw", rawValue: raw });
        controller.close();
      },
    }),
  });
  const response = await subscriptionResponses(
    {
      model: "gpt-6-sol",
      stream: true,
      reasoning: { effort: "high" },
      input: [
        { role: "developer", content: "Research the retained source." },
        {
          role: "user",
          content: [{ type: "input_text", text: "Original item F17SB" }],
        },
        {
          type: "reasoning",
          id: "synthetic-reasoning",
          encrypted_content: "synthetic-encrypted",
          content: [],
          summary: [{ type: "summary_text", text: "Inspect original" }],
        },
        {
          type: "function_call",
          call_id: "synthetic-call",
          name: "work_observe",
          arguments: '{"kind":"read"}',
        },
        {
          type: "function_call_output",
          call_id: "synthetic-call",
          output: '{"evidenceId":"synthetic-evidence"}',
        },
      ],
      tools: [
        {
          type: "function",
          name: "work_resolve",
          description: "Resolve supported claims",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "work_resolve" },
    },
    new AbortController().signal,
    () => ({ doStream }),
  );
  expect(await response.text()).toBe(`data: ${JSON.stringify(raw)}\n\n`);
  expect(doStream.mock.lastCall?.[0]).toMatchObject({
    includeRawChunks: true,
    toolChoice: { type: "tool", toolName: "work_resolve" },
    tools: [{ name: "work_resolve", strict: true }],
    providerOptions: { openai: { store: false, reasoningEffort: "high" } },
    prompt: [
      { role: "system", content: "Research the retained source." },
      {
        role: "user",
        content: [{ type: "text", text: "Original item F17SB" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Inspect original",
            providerOptions: {
              openai: {
                itemId: "synthetic-reasoning",
                reasoningEncryptedContent: "synthetic-encrypted",
              },
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "synthetic-call",
            toolName: "work_observe",
            input: { kind: "read" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "synthetic-call",
            toolName: "work_observe",
            output: {
              type: "text",
              value: '{"evidenceId":"synthetic-evidence"}',
            },
          },
        ],
      },
    ],
  });
});

it("refuses unsupported original shapes before invoking the subscription", async () => {
  const { subscriptionResponses } = await import("./local-chatgpt-provider");
  const doStream = vi.fn();
  await expect(
    subscriptionResponses(
      {
        model: "gpt-6-sol",
        input: [
          {
            type: "function_call_output",
            call_id: "foreign-call",
            output: "unknown",
          },
        ],
      },
      new AbortController().signal,
      () => ({ doStream }),
    ),
  ).rejects.toThrow("Unknown function result");
  await expect(
    subscriptionResponses(
      {
        model: "gpt-6-sol",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "https://example.test/image.png",
              },
            ],
          },
        ],
      },
      new AbortController().signal,
      () => ({ doStream }),
    ),
  ).rejects.toThrow("Invalid input");
  expect(doStream).not.toHaveBeenCalled();
});

it("cancels the SDK inference when the response reader disconnects", async () => {
  const { subscriptionResponses } = await import("./local-chatgpt-provider");
  const cancelled = vi.fn();
  const doStream = vi
    .fn()
    .mockResolvedValue({ stream: new ReadableStream({ cancel: cancelled }) });
  const response = await subscriptionResponses(
    {
      model: "gpt-6-sol",
      input: [{ role: "user", content: "Original source" }],
    },
    new AbortController().signal,
    () => ({ doStream }),
  );
  await response.body?.cancel();
  expect(doStream.mock.lastCall?.[0].abortSignal.aborted).toBe(true);
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it("ends a pending subscription stream when its deadline expires", async () => {
  const { subscriptionResponses } = await import("./local-chatgpt-provider");
  const cancelled = vi.fn();
  const doStream = vi
    .fn()
    .mockResolvedValue({ stream: new ReadableStream({ cancel: cancelled }) });
  const controller = new AbortController();
  const response = await subscriptionResponses(
    {
      model: "gpt-6-sol",
      input: [{ role: "user", content: "Original source" }],
    },
    controller.signal,
    () => ({ doStream }),
  );
  const body = response.text();
  controller.abort(new Error("Synthetic deadline expired"));
  await expect(body).rejects.toThrow("Synthetic deadline expired");
  expect(cancelled).toHaveBeenCalledTimes(1);
}, 1_000);

it("preserves pi assistant replay phase through the actual public SDK serializer", async () => {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const { subscriptionResponses } = await import("./local-chatgpt-provider");
  const raw = {
    type: "response.completed",
    response: { usage: { input_tokens: 2, output_tokens: 1 } },
  };
  const fetchSdk = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(`data: ${JSON.stringify(raw)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  const provider = createOpenAI({
    apiKey: "synthetic-external-seam",
    fetch: fetchSdk,
  });
  const response = await subscriptionResponses(
    {
      model: "gpt-6-sol",
      input: [
        {
          type: "message",
          role: "assistant",
          id: "msg_synthetic",
          phase: "commentary",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Read original receipt",
              annotations: [],
            },
          ],
        },
      ],
    },
    new AbortController().signal,
    (model) => provider.responses(model),
  );
  expect(await response.text()).toBe(`data: ${JSON.stringify(raw)}\n\n`);
  const [, init] = fetchSdk.mock.lastCall ?? [];
  expect(JSON.parse(String(init?.body))).toMatchObject({
    store: false,
    input: [
      {
        role: "assistant",
        phase: "commentary",
        content: "Read original receipt",
      },
    ],
  });
});

it("records incomplete subscription streams as failed attempts without inventing usage", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Synthetic interrupted response"));
        },
      }),
    ),
  );
  const env = {
    ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    AI_GATEWAY_API_KEY: "",
    GATEWAY_ENVIRONMENT: "development" as const,
    SUBSCRIPTION_REQUIRED: "true",
    SUBSCRIPTION_PROVIDER_URL: "http://127.0.0.1:43123",
  };
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  };
  await agentEvalModel.fetch(
    new Request("https://eval.test/configure", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }),
    }),
    env,
    ctx,
  );
  await agentEvalModel.fetch(
    new Request("https://eval.test/openai/responses", {
      method: "POST",
      body: JSON.stringify({ input: [], stream: true }),
    }),
    env,
    ctx,
  );
  await Promise.allSettled(pending);
  const response = await agentEvalModel.fetch(
    new Request("https://eval.test/usage"),
    env,
    ctx,
  );
  expect(await response.json()).toMatchObject({
    transport: "chatgpt",
    requests: 1,
    failedRequests: 1,
    calls: [],
    inputTokens: 0,
    outputTokens: 0,
  });
});

it("bounds pending SDK admission and cancels a late subscription response", async () => {
  const { subscriptionResponses } = await import("./local-chatgpt-provider");
  type StreamResult = Awaited<
    ReturnType<
      ReturnType<typeof import("e2e/oauth/chatgpt").chatgpt>["doStream"]
    >
  >;
  const gate = Promise.withResolvers<StreamResult>();
  const doStream = vi.fn(() => gate.promise);
  const cancelled = vi.fn();
  const controller = new AbortController();
  const pending = subscriptionResponses(
    {
      model: "gpt-6-sol",
      input: [{ role: "user", content: "Original source" }],
    },
    controller.signal,
    () => ({ doStream }),
  );
  controller.abort(new Error("Synthetic admission deadline"));
  const result = await Promise.race([
    pending.then(
      () => "unexpected response",
      (error: Error) => error.message,
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("still awaiting SDK"), 20),
    ),
  ]);
  gate.resolve({ stream: new ReadableStream({ cancel: cancelled }) });
  const late = await pending.catch(() => undefined);
  await late?.body?.cancel().catch(() => undefined);
  await Promise.resolve();
  expect(result).toBe("Synthetic admission deadline");
  expect(cancelled).toHaveBeenCalledTimes(1);
});

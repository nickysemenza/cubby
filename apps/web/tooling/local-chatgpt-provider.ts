import { createServer } from "node:http";
import { once } from "node:events";

import { chatgpt } from "e2e/oauth/chatgpt";
import { z } from "zod";

import { modelSwapSchema } from "./responses-model-swap";
import { chatGptResponseLifetime } from "../src/server/ai/chatgpt/rpc";

type SubscriptionModel = Pick<ReturnType<typeof chatgpt>, "doStream">;
type CallOptions = Parameters<SubscriptionModel["doStream"]>[0];
type FunctionTool = Extract<
  NonNullable<CallOptions["tools"]>[number],
  { type: "function" }
>;
const textPart = z
  .object({
    type: z.enum(["input_text", "output_text"]),
    text: z.string(),
    annotations: z.array(z.never()).optional(),
  })
  .strict();
const message = z
  .object({
    type: z.literal("message").optional(),
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([
      z.string(),
      z
        .array(textPart)
        .transform((parts) => parts.map((part) => part.text).join("\n")),
    ]),
    id: z.string().optional(),
    status: z.string().optional(),
    phase: z.enum(["commentary", "final_answer"]).optional(),
  })
  .strict();
const call = z
  .object({
    type: z.literal("function_call"),
    name: z.string(),
    call_id: z.string(),
    arguments: z.string(),
    id: z.string().optional(),
    status: z.string().optional(),
  })
  .strict();
const result = z
  .object({
    type: z.literal("function_call_output"),
    call_id: z.string(),
    output: z.string(),
    id: z.string().optional(),
    status: z.string().optional(),
  })
  .strict();
const reasoning = z
  .object({
    type: z.literal("reasoning"),
    id: z.string(),
    encrypted_content: z.string().nullable().optional(),
    content: z.array(z.never()).optional(),
    summary: z.array(
      z.object({ type: z.literal("summary_text"), text: z.string() }).strict(),
    ),
    status: z.string().optional(),
  })
  .strict();
const tool = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  strict: z.boolean().optional(),
  parameters: z.custom<FunctionTool["inputSchema"]>(
    (value) => z.record(z.string(), z.json()).safeParse(value).success,
  ),
});
const conversationItem = z.union([message, call, result, reasoning]);
const additionalTools = z
  .object({
    type: z.literal("additional_tools"),
    role: z.literal("developer"),
    tools: z.array(tool),
  })
  .strict();
const requestBody = z
  .object({
    model: modelSwapSchema.shape.model,
    input: z.array(z.union([conversationItem, additionalTools])),
    tools: z.array(tool).optional(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]).transform((type) => ({ type })),
        z
          .object({ type: z.literal("function"), name: z.string() })
          .transform(({ name }) => ({ type: "tool" as const, toolName: name })),
      ])
      .optional(),
    reasoning: z
      .object({
        effort: modelSwapSchema.shape.effort,
        summary: z.string().optional(),
      })
      .optional(),
    instructions: z.string().optional(),
    stream: z.literal(true).optional(),
    store: z.boolean().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    parallel_tool_calls: z.boolean().optional(),
    prompt_cache_key: z.string().optional(),
    prompt_cache_retention: z.enum(["in_memory", "24h"]).optional(),
    prompt_cache_options: z
      .object({
        mode: z.enum(["implicit", "explicit"]).optional(),
        ttl: z.literal("30m").optional(),
      })
      .optional(),
    include: z.array(z.literal("reasoning.encrypted_content")).optional(),
  })
  .strict();

function conversation(
  input: Array<z.infer<typeof conversationItem>>,
): CallOptions["prompt"] {
  const names = new Map<string, string>();
  return input.map((item): CallOptions["prompt"][number] => {
    if (item.type === "function_call") {
      names.set(item.call_id, item.name);
      return {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: item.call_id,
            toolName: item.name,
            input: JSON.parse(item.arguments),
            providerOptions: { openai: { itemId: item.id } },
          },
        ],
      };
    }
    if (item.type === "function_call_output") {
      const name = names.get(item.call_id);
      if (!name) throw new Error(`Unknown function result ${item.call_id}`);
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: item.call_id,
            toolName: name,
            output: { type: "text", value: item.output },
          },
        ],
      };
    }
    if (item.type === "reasoning") {
      const summaries = item.summary.length
        ? item.summary
        : [{ type: "summary_text", text: "" }];
      return {
        role: "assistant",
        content: summaries.map(({ text }) => ({
          type: "reasoning",
          text,
          providerOptions: {
            openai: {
              itemId: item.id,
              reasoningEncryptedContent: item.encrypted_content,
            },
          },
        })),
      };
    }
    const content = item.content;
    if (item.role === "system" || item.role === "developer")
      return { role: "system", content };
    return {
      role: item.role,
      content: [
        {
          type: "text",
          text: content,
          providerOptions: { openai: { itemId: item.id, phase: item.phase } },
        },
      ],
    };
  });
}

async function awaitSdkStream(
  pending: PromiseLike<Awaited<ReturnType<SubscriptionModel["doStream"]>>>,
  signal: AbortSignal,
) {
  const result = Promise.resolve(pending);
  let rejectAbort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
  });
  const abort = () => rejectAbort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  void result.then(
    (late) => {
      if (signal.aborted)
        void late.stream.cancel(signal.reason).catch(() => {
          // SILENT: caller cancellation already carries the failure; cancel late work.
        });
    },
    () => undefined,
  );
  try {
    return await Promise.race([result, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Public subscription SDK only; unsupported input fails before credential use. */
export async function subscriptionResponses(
  body: unknown,
  signal: AbortSignal,
  modelFor: (
    id: z.infer<typeof requestBody>["model"],
  ) => SubscriptionModel = chatgpt,
): Promise<Response> {
  const parsed = requestBody.parse(body);
  const declarations = parsed.input.filter(
    (item) => item.type === "additional_tools",
  );
  if (declarations.length > 1 || (declarations.length && parsed.tools?.length))
    throw new Error(
      "Subscription evaluation requires one fixed function-tool declaration",
    );
  const tools = parsed.tools ?? declarations[0]?.tools;
  const prompt = conversation(
    parsed.input.filter((item) => item.type !== "additional_tools"),
  );
  const toolChoice = parsed.tool_choice;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const combined = controller.signal;
  try {
    combined.throwIfAborted();
    const output = await awaitSdkStream(
      modelFor(parsed.model).doStream({
        prompt,
        tools: tools?.map(({ parameters, ...entry }) => ({
          ...entry,
          inputSchema: parameters,
        })),
        toolChoice,
        includeRawChunks: true,
        abortSignal: combined,
        providerOptions: {
          openai: {
            store: false,
            forceReasoning: true,
            systemMessageMode: "developer",
            reasoningEffort: parsed.reasoning?.effort,
            reasoningSummary: parsed.reasoning?.summary,
            instructions: parsed.instructions,
            parallelToolCalls: parsed.parallel_tool_calls,
            promptCacheKey: parsed.prompt_cache_key,
          },
        },
      }),
      combined,
    );
    const encoder = new TextEncoder();
    const stream = output.stream.pipeThrough(
      new TransformStream({
        transform(part, destination) {
          if (part.type === "error") throw part.error;
          if (part.type === "raw")
            destination.enqueue(
              encoder.encode(`data: ${JSON.stringify(part.rawValue)}\n\n`),
            );
        },
      }),
    );
    return chatGptResponseLifetime(
      new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "x-cubby-eval-transport": "chatgpt",
        },
      }),
      combined,
      () => signal.removeEventListener("abort", abort),
      () => controller.abort(new Error("Subscription stream cancelled")),
    );
  } catch (error) {
    signal.removeEventListener("abort", abort);
    throw error;
  }
}

/** Loopback-only transport; credentials stay inside the E2E SDK's store. */
export async function startLocalChatGptProvider() {
  const active = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    active.add(controller);
    response.once("close", () =>
      controller.abort(new Error("Subscription client disconnected")),
    );
    try {
      if (request.method !== "POST" || request.url !== "/responses")
        throw new Error("Only subscription Responses requests are permitted");
      const timeoutMs = z.coerce
        .number()
        .int()
        .positive()
        .max(480_000)
        .parse(request.headers["x-cubby-eval-timeout-ms"]);
      const buffers: Buffer[] = [];
      let size = 0;
      for await (const part of request) {
        const bytes = Buffer.from(part);
        size += bytes.length;
        if (size > 4_000_000)
          throw new Error("Subscription evaluation request is oversized");
        buffers.push(bytes);
      }
      const result = await subscriptionResponses(
        JSON.parse(Buffer.concat(buffers).toString("utf8")),
        AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      for await (const chunk of result.body ?? []) {
        if (!response.write(chunk))
          await once(response, "drain", { signal: controller.signal });
      }
      response.end();
    } catch (error) {
      if (!response.headersSent)
        response
          .writeHead(502, { "content-type": "text/plain" })
          .end(error instanceof Error ? error.message : String(error));
      else
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
    } finally {
      active.delete(controller);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const controller of active)
        controller.abort(new Error("Subscription evaluation closed"));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

import type {
  ChatGptAuthorization,
  ChatGptModel,
  ChatGptStatus,
} from "@cubby/schemas/chatgpt";
import type { gatewayQuery } from "@cubby/shared/ai-gateway-request";
import { z } from "zod";

const MAX_INFERENCE_MS = 5 * 60_000;
export const chatGptInferenceOptions = z.object({
  requestId: z.string().min(1).max(128),
  timeoutMs: z.number().int().positive().max(MAX_INFERENCE_MS),
});
export type ChatGptInferenceOptions = z.infer<typeof chatGptInferenceOptions>;
export function chatGptInferenceDeadline(timeoutMs?: number): number {
  return Math.min(timeoutMs ?? MAX_INFERENCE_MS, MAX_INFERENCE_MS);
}

/** Keep cancellation and deadline ownership until the streamed body settles. */
export function chatGptResponseLifetime(
  response: Response,
  signal: AbortSignal,
  finish: () => void,
  cancel: () => void,
): Response {
  if (!response.body) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  let abort: () => void;
  const cleanup = () => {
    closed = true;
    signal.removeEventListener("abort", abort);
    finish();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (closed) return;
        cleanup();
        controller.error(signal.reason);
        void reader.cancel(signal.reason).catch(() => {
          // SILENT: the aborted stream already carries the original reason.
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (closed) return;
        if (chunk.done) {
          cleanup();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        if (closed) return;
        cleanup();
        controller.error(error);
      }
    },
    cancel(reason) {
      closed = true;
      const cancelled = reader.cancel(reason);
      cancel();
      cleanup();
      return cancelled;
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

type Inference = (
  body: Awaited<ReturnType<typeof gatewayQuery>>,
  model: string,
  signal: AbortSignal,
) => Promise<Response>;

/** Request IDs cross RPC; AbortSignals stay with the upstream token owner. */
export class ChatGptInferenceRequests {
  private readonly requests = new Map<
    string,
    {
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly upstream: Inference) {}

  private request(requestId: string, timeoutMs: number) {
    const existing = this.requests.get(requestId);
    if (existing) return existing;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("ChatGPT inference exceeded its deadline"));
      this.requests.delete(requestId);
    }, timeoutMs);
    const request = { controller, timer };
    this.requests.set(requestId, request);
    return request;
  }

  cancel(requestId: string): void {
    // Preserve an early cancel until its infer RPC arrives; the deadline also
    // bounds cancelled IDs whose caller never reaches inference admission.
    this.request(requestId, MAX_INFERENCE_MS).controller.abort(
      new Error("ChatGPT inference cancelled"),
    );
  }

  async infer(
    body: Awaited<ReturnType<typeof gatewayQuery>>,
    model: string,
    raw: ChatGptInferenceOptions,
  ): Promise<Response> {
    const options = chatGptInferenceOptions.parse(raw);
    const { controller, timer } = this.request(
      options.requestId,
      options.timeoutMs,
    );
    const finish = () => {
      clearTimeout(timer);
      this.requests.delete(options.requestId);
    };
    try {
      controller.signal.throwIfAborted();
      const response = await this.upstream(body, model, controller.signal);
      return chatGptResponseLifetime(response, controller.signal, finish, () =>
        controller.abort(new Error("ChatGPT inference stream cancelled")),
      );
    } catch (error) {
      finish();
      throw error;
    }
  }
}

export interface ChatGptPlanRpc {
  status(): Promise<ChatGptStatus>;
  authorizationHost(): Promise<{ hostId: string; clientId: string | null }>;
  connect(input: ChatGptAuthorization): Promise<ChatGptStatus>;
  models(): Promise<ChatGptModel[]>;
  disconnect(): Promise<void>;
  infer(
    body: Awaited<ReturnType<typeof gatewayQuery>>,
    model: string,
    options: ChatGptInferenceOptions,
  ): Promise<Response>;
  cancel(requestId: string): Promise<void>;
}

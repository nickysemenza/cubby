import { getErrorMessage } from "@cubby/shared";
import { gatewayFetchThrough } from "@cubby/shared/ai/gateway-request";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectedChatGptInference, inferChatGptPlan } from "./client";
import { ChatGptInferenceRequests, type ChatGptPlanRpc } from "./rpc";
import {
  ChatGptSession,
  type ChatGptConnection,
  type CredentialStore,
} from "./session";

afterEach(() => vi.useRealTimers());

// Failures: serializing an AbortSignal, waiting forever on an unresponsive
// RPC, losing cancellation after headers, and ignoring consumer cancellation.
describe("ChatGPT caller cancellation bridge", () => {
  it("rejects promptly and sends cancellation if inference never returns", async () => {
    const abort = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const plan = fromPartial<ChatGptPlanRpc>({
      infer: async () => new Promise<Response>(() => undefined),
      cancel,
    });
    const pending = inferChatGptPlan(
      plan,
      { model: "gpt-6-sol" },
      { signal: abort.signal },
    );
    const rejected = pending.then(() => "unexpected success", getErrorMessage);
    abort.abort(new Error("example cancellation"));
    expect(await rejected).toContain("example cancellation");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates caller abort and consumer cancellation through streaming", async () => {
    let upstream: AbortSignal | undefined;
    const requests = new ChatGptInferenceRequests(
      async (_body, _model, signal) => {
        upstream = signal;
        return new Response(new ReadableStream<Uint8Array>());
      },
    );
    const plan = fromPartial<ChatGptPlanRpc>({
      infer: (...args: Parameters<ChatGptPlanRpc["infer"]>) =>
        requests.infer(...args),
      cancel: async (id: string) => requests.cancel(id),
    });
    const abort = new AbortController();
    const response = await inferChatGptPlan(
      plan,
      { model: "gpt-6-sol" },
      { signal: abort.signal },
    );
    const rejected = response
      .text()
      .then(() => "unexpected success", getErrorMessage);
    abort.abort(new Error("example cancellation"));
    expect(await rejected).toContain("example cancellation");
    expect(upstream?.aborted).toBe(true);
    const cancelled = await inferChatGptPlan(plan, { model: "gpt-6-sol" });
    await cancelled.body?.cancel();
    expect(upstream?.aborted).toBe(true);
  });

  it("bounds a stalled RPC by the configured deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const plan = fromPartial<ChatGptPlanRpc>({
      infer: async () => new Promise<Response>(() => undefined),
      cancel,
    });
    const pending = inferChatGptPlan(
      plan,
      { model: "gpt-6-sol" },
      { requestTimeoutMs: 25 },
    );
    const rejected = pending.then(() => "unexpected success", getErrorMessage);
    await vi.advanceTimersByTimeAsync(25);
    expect(await rejected).toContain("deadline");
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// A disabled connection must be skipped before transport selection, just like disconnect.
it("skips a plan needing reauthorization", async () => {
  const infer = vi.fn<ChatGptPlanRpc["infer"]>();
  const onSelected = vi.fn();
  const plan = fromPartial<ChatGptPlanRpc>({
    status: async () => ({ connected: true, needsReauthorization: true }),
    infer,
  });
  expect(
    await connectedChatGptInference(
      plan,
      { model: "gpt-6-sol" },
      { onSelected },
    ),
  ).toBeNull();
  expect(infer).not.toHaveBeenCalled();
  expect(onSelected).not.toHaveBeenCalled();
});

// Exercise the real funding router: an unavailable plan must preserve paid
// admission for normal callers and fail closed for subscription-only callers.
it.each([undefined, "subscription"] as const)(
  "routes a disabled plan with funding %s",
  async (funding) => {
    const plan = fromPartial<ChatGptPlanRpc>({
      status: async () => ({
        connected: true,
        needsReauthorization: true,
        email: null,
      }),
    });
    const gateway = vi.fn(async () => Response.json({ example: "paid" }));
    const admission = vi.fn(async () => undefined);
    const send = gatewayFetchThrough({
      provider: "openai",
      funding,
      chatGpt: (body, options) =>
        connectedChatGptInference(plan, body, options),
      beforePaidRequest: admission,
      gateway,
    });
    const response = await send("https://ai-gateway.invalid/openai/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });
    expect(await response.json()).toMatchObject(
      funding
        ? { error: { code: "subscription_unavailable" } }
        : { example: "paid" },
    );
    expect(gateway).toHaveBeenCalledTimes(funding ? 0 : 1);
    expect(admission).toHaveBeenCalledTimes(funding ? 0 : 1);
  },
);

// Refresh can discover unusable credentials only after the funding ladder selects
// the plan. The discovering call must advance, while subscription-only stays closed.
it.each(["invalid_client", "scope removed", "temporary failure"])(
  "routes the discovering refresh request: %s",
  async (failure) => {
    for (const funding of [undefined, "subscription"] as const) {
      const records = new Map<string, ChatGptConnection | string>([
        [
          "connection",
          {
            connected: true,
            clientId: "oaiapp_example",
            subject: "example-subject",
            email: null,
            accessToken: "example-access",
            refreshToken: "example-refresh",
            expiresAt: 0,
          },
        ],
      ]);
      const store: CredentialStore = {
        get: async (key) => records.get(key),
        put: async (key, value) => {
          records.set(key, value);
        },
        delete: async (key) => records.delete(key),
      };
      const upstream = vi.fn<typeof fetch>(async () =>
        failure === "scope removed"
          ? Response.json({
              access_token: "next-access",
              refresh_token: "next-refresh",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "resource.invoke",
            })
          : Response.json(
              { error: failure },
              { status: failure === "invalid_client" ? 400 : 503 },
            ),
      );
      const session = new ChatGptSession(store, upstream);
      const plan = fromPartial<ChatGptPlanRpc>({
        status: () => session.status(),
        infer: (...[body, model]: Parameters<ChatGptPlanRpc["infer"]>) =>
          session.infer(body, model),
      });
      const gateway = vi.fn(async () => Response.json({ example: "paid" }));
      const admission = vi.fn(async () => undefined);
      const send = gatewayFetchThrough({
        provider: "openai",
        funding,
        chatGpt: (body, options) =>
          connectedChatGptInference(plan, body, options),
        beforePaidRequest: admission,
        gateway,
      });
      const pending = send("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol" }),
      });
      const result = await pending.then(
        async (response) => ({ body: await response.json(), error: null }),
        (error) => ({ body: null, error: getErrorMessage(error) }),
      );
      const temporaryError = expect.stringContaining("temporary failure");
      expect(result).toMatchObject(
        failure === "temporary failure"
          ? { body: null, error: temporaryError }
          : {
              body: funding
                ? { error: { code: "subscription_unavailable" } }
                : { example: "paid" },
              error: null,
            },
      );
      const paidCalls = failure !== "temporary failure" && !funding ? 1 : 0;
      expect(gateway).toHaveBeenCalledTimes(paidCalls);
      expect(admission).toHaveBeenCalledTimes(paidCalls);
      expect(upstream).toHaveBeenCalledOnce();
    }
  },
);

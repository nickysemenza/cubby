import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getErrorMessage } from "~/lib/error-utils";

import { inferChatGptPlan } from "./client";
import { ChatGptInferenceRequests, type ChatGptPlanRpc } from "./rpc";

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

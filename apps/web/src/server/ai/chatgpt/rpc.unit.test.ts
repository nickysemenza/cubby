import { afterEach, describe, expect, it, vi } from "vitest";

import { getErrorMessage } from "~/lib/error-utils";

import { ChatGptInferenceRequests } from "./rpc";

afterEach(() => vi.useRealTimers());

// Failures: cancellation before admission, a stalled RPC, a stalled stream,
// and retaining a completed stream's deadline or cancellation controller.
describe("ChatGPT inference request ownership", () => {
  it("cancels a stalled inference and rejects cancellation before admission", async () => {
    let signal: AbortSignal | undefined;
    const requests = new ChatGptInferenceRequests(
      async (_body, _model, abort) => {
        signal = abort;
        return new Promise<Response>((_resolve, reject) => {
          abort.addEventListener("abort", () => reject(abort.reason), {
            once: true,
          });
        });
      },
    );
    const pending = requests.infer({}, "gpt-6-sol", {
      requestId: "first",
      timeoutMs: 1000,
    });
    const rejected = pending.then(() => "unexpected success", getErrorMessage);
    requests.cancel("first");
    expect(await rejected).toContain("cancelled");
    expect(signal?.aborted).toBe(true);
    requests.cancel("early");
    await expect(
      requests.infer({}, "gpt-6-sol", { requestId: "early", timeoutMs: 1000 }),
    ).rejects.toThrow("cancelled");
  });

  it("keeps a deadline through streaming and clears it after completion", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const requests = new ChatGptInferenceRequests(
      async (_body, _model, abort) => {
        signal = abort;
        return new Response(new ReadableStream<Uint8Array>());
      },
    );
    const response = await requests.infer({}, "gpt-6-sol", {
      requestId: "stream",
      timeoutMs: 50,
    });
    const rejected = response
      .text()
      .then(() => "unexpected success", getErrorMessage);
    await vi.advanceTimersByTimeAsync(50);
    expect(await rejected).toContain("deadline");
    expect(signal?.aborted).toBe(true);

    const completed = new ChatGptInferenceRequests(
      async (_body, _model, abort) => {
        signal = abort;
        return new Response("done");
      },
    );
    const done = await completed.infer({}, "gpt-6-sol", {
      requestId: "done",
      timeoutMs: 50,
    });
    expect(await done.text()).toBe("done");
    await vi.advanceTimersByTimeAsync(50);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

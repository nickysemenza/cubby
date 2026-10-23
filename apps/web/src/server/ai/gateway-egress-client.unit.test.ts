import type {
  GatewayFetchRequest,
  GatewayControls,
} from "@cubby/shared/ai/gateway-request";
import { afterEach, expect, it, vi } from "vitest";

import { AiWorkDeferredError, withCooperativeAiWork } from "./cooperative-work";
import {
  coordinatedGatewayRequest,
  GatewayAdmissionWaitError,
} from "./gateway-egress-client";

afterEach(() => vi.useRealTimers());
const controls = {
  metadata: {
    environment: "production",
    feature: "synthetic",
    operation: "synthetic",
  },
} satisfies GatewayControls;
const syntheticRequest = (): GatewayFetchRequest => ({
  endpoint: "responses",
  input: "https://gateway.internal/responses",
  init: { method: "POST", body: "{}" },
  headers: new Headers(),
  signal: undefined,
  query: async () => ({}),
});

// A short admission wait releases the invocation without inflating its retry deadline.
it.each([1, 60])(
  "yields after one attempt and preserves a %s-second retry deadline",
  async (seconds) => {
    vi.useFakeTimers();
    let attempts = 0;
    const pending = withCooperativeAiWork(() =>
      coordinatedGatewayRequest(
        {
          fetch: async () => {
            attempts++;
            return new Response("wait", {
              status: 429,
              headers: {
                "x-cubby-admission-wait": "true",
                "retry-after": String(seconds),
              },
            });
          },
        },
        "workers-ai",
        syntheticRequest(),
        controls,
      ),
    );
    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AiWorkDeferredError &&
        error.until === Date.now() + seconds * 1_000,
    );
    expect(attempts).toBe(1);
  },
);

it("waits for shared admission without returning a provider failure or spending another request body", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const stub = {
    fetch: async () =>
      ++attempts === 1
        ? new Response("wait", {
            status: 429,
            headers: { "x-cubby-admission-wait": "true", "retry-after": "1" },
          })
        : new Response("synthetic result"),
  };
  const request = syntheticRequest();
  const pending = coordinatedGatewayRequest(stub, "openai", request, controls);
  await vi.runAllTimersAsync();
  expect(await (await pending).text()).toBe("synthetic result");
  expect(attempts).toBe(2);
});

it("reports a typed deferral when the cooldown exceeds the admission deadline", async () => {
  const request = syntheticRequest();
  await expect(
    coordinatedGatewayRequest(
      {
        fetch: async () =>
          new Response("wait", {
            status: 429,
            headers: { "x-cubby-admission-wait": "true", "retry-after": "60" },
          }),
      },
      "openai",
      request,
      controls,
    ),
  ).rejects.toBeInstanceOf(GatewayAdmissionWaitError);
});

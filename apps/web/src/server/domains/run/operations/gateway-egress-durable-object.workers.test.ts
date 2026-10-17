import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A shared gateway window must survive different stubs and release capacity on cancellation.
describe("shared Gateway admission", () => {
  it("keeps subscriber-credit cooldown from delaying unified fallback", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.now();
    const credit = await stub.admit("subscriber-credit:anthropic", now);
    expect(credit.kind).toBe("admitted");
    if (credit.kind !== "admitted") throw new Error("Credit admission refused");
    await stub.finish(credit.token, 429, "60", now);
    expect(await stub.admit("subscriber-credit:anthropic", now + 1)).toEqual({
      kind: "wait",
      until: now + 60_000,
    });
    const unified = await stub.admit("unified", now + 1);
    expect(unified.kind).toBe("admitted");
    if (unified.kind === "admitted")
      await stub.finish(unified.token, 200, null, now + 1);
  });

  it("shares the aggregate budget and cooldown across callers without spending capacity on a refusal", async () => {
    const name = crypto.randomUUID();
    const first = env.AI_GATEWAY_EGRESS.getByName(name);
    const second = env.AI_GATEWAY_EGRESS.getByName(name);
    const now = Date.now();
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) {
      const admitted = await first.admit("unified", now);
      expect(admitted.kind).toBe("admitted");
      if (admitted.kind === "admitted") tokens.push(admitted.token);
    }
    expect(await second.admit("unified", now)).toMatchObject({ kind: "wait" });
    await second.finish(tokens[0]!, 429, "60", now);
    expect(await first.admit("unified", now + 1)).toMatchObject({
      kind: "wait",
      until: now + 60_000,
    });
    for (const token of tokens.slice(1))
      await first.finish(token, 200, null, now);
    expect((await second.admit("unified", now + 60_001)).kind).toBe("admitted");
  });
  it("refuses request 181 across independent stubs until the rolling window expires", async () => {
    const name = crypto.randomUUID();
    const now = Date.now();
    for (let i = 0; i < 180; i++) {
      const stub = env.AI_GATEWAY_EGRESS.getByName(name);
      const admitted = await stub.admit("unified", now);
      expect(admitted.kind).toBe("admitted");
      if (admitted.kind === "admitted")
        await stub.finish(admitted.token, 200, null, now);
    }
    const stub = env.AI_GATEWAY_EGRESS.getByName(name);
    expect(await stub.admit("unified", now + 59_999)).toEqual({
      kind: "wait",
      until: now + 60_000,
    });
    expect((await stub.admit("unified", now + 60_000)).kind).toBe("admitted");
  });

  it("forwards provider headers and releases the durable permit when a stream completes or cancellation rejects", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance) => {
      const calls: unknown[] = [];
      let failCancel = false;
      let cancellationFailed = false;
      Object.defineProperty(instance, "env", {
        value: {
          AI: {
            gateway: () => ({
              run: async (request: unknown) => {
                calls.push(request);
                return new Response(
                  failCancel
                    ? new ReadableStream({
                        start(controller) {
                          controller.enqueue(new Uint8Array([1]));
                        },
                        cancel() {
                          cancellationFailed = true;
                          throw new Error(
                            "Synthetic upstream cancellation failure",
                          );
                        },
                      })
                    : "synthetic response",
                );
              },
            }),
          },
        },
      });
      const request = () =>
        new Request("https://gateway.internal/egress", {
          method: "POST",
          body: JSON.stringify({
            provider: "anthropic",
            endpoint: "v1/messages",
            query: {},
            headers: { "anthropic-version": "2023-06-01" },
            controls: {
              metadata: {
                environment: "production",
                feature: "synthetic",
                operation: "synthetic",
              },
            },
          }),
        });
      expect(await (await instance.fetch(request())).text()).toBe(
        "synthetic response",
      );
      expect(calls[0]).toMatchObject({
        headers: { "anthropic-version": "2023-06-01" },
      });
      failCancel = true;
      const response = await instance.fetch(request());
      await Promise.allSettled([
        response.body!.cancel("synthetic cancellation"),
      ]);
      expect(cancellationFailed).toBe(true);
      for (let i = 0; i < 4; i++)
        expect((await instance.admit("unified")).kind).toBe("admitted");
    });
  });
});

// Idle version nudges must succeed without any usable database binding.
it("keeps unchanged policy nudges entirely in durable storage without opening Neon", async () => {
  const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance, state) => {
    Object.defineProperty(instance, "env", {
      value: {
        AI_REFRESH_ENABLED: "true",
        CF_VERSION_METADATA: { id: "synthetic-current-version" },
      },
    });
    await state.storage.put(
      "aiRefreshObservedVersion",
      "synthetic-current-version",
    );
    await instance.observeAiRefresh();
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it("keeps startup retry cooldown and maintenance alarms out of Neon", async () => {
  const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance, state) => {
    Object.defineProperty(instance, "env", {
      value: { CF_VERSION_METADATA: { id: "synthetic-retrying-version" } },
      configurable: true,
    });
    const retryAt = Date.now() + 60_000;
    await state.storage.put("aiRefreshPendingObservation", {
      version: "synthetic-retrying-version",
      epoch: 1,
    });
    await state.storage.setAlarm(retryAt);
    await instance.observeAiRefresh();
    expect(await state.storage.getAlarm()).toBe(retryAt);
    Object.defineProperty(instance, "env", {
      value: { MAINTENANCE_MODE: "true" },
    });
    await instance.alarm();
    expect(await state.storage.getAlarm()).toBeGreaterThan(retryAt);
  });
});

// A failed handoff can commit Neon before its Durable Object acknowledgement.
it("allocates newer ownership when rolling back over a pending newer version", async () => {
  const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance, state) => {
    Object.defineProperty(instance, "env", {
      value: { CF_VERSION_METADATA: { id: "synthetic-a" } },
    });
    await state.storage.put({
      aiRefreshObservedVersion: "synthetic-a",
      aiRefreshObservationEpoch: 2,
      aiRefreshPendingObservation: { version: "synthetic-b", epoch: 2 },
    });
    await instance.observeAiRefresh().catch(() => {});
    expect(await state.storage.get("aiRefreshPendingObservation")).toEqual({
      version: "synthetic-a",
      epoch: 3,
    });
  });
});

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A shared gateway window must survive different stubs and release capacity on cancellation.
describe("shared Gateway admission", () => {
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

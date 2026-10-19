import { isInferenceFundingRefusal } from "@cubby/shared/ai/gateway-request";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { aiBudgetWindow } from "~/server/ai/budget-window";

const CREDIT = "subscriber-credit:anthropic";
const SIX_HOURS = 6 * 60 * 60_000;
const CONSOLE_LIMIT =
  '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2099-11-01 at 00:00 UTC."}}';
const NAMED_UNTIL = Date.parse("2099-11-01T00:00:00Z");
const LOW_BALANCE =
  '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';
const egressRequest = (headers: Record<string, string>) =>
  new Request("https://gateway.internal/egress", {
    method: "POST",
    body: JSON.stringify({
      provider: "anthropic",
      endpoint: "v1/messages",
      query: {},
      headers,
      controls: {
        metadata: {
          environment: "production",
          feature: "synthetic",
          operation: "synthetic",
        },
      },
    }),
  });
const creditRequest = () =>
  egressRequest({
    "cf-aig-byok-alias": "subscriber-credit",
    "cf-aig-no-wholesale": "true",
  });

// Failure modes: every request re-tries a Console-refused credit key (seconds
// of latency each); the refusal outlives Anthropic's named date or never
// expires without one; Cubby's own window stop is mistaken for Anthropic's;
// no request ever probes the key again; reset leaves it refused; unified
// traffic is refused with it.
describe("Claude credit refusal", () => {
  it("records a Console limit until its named date and refuses later credit requests without calling Anthropic", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance) => {
      const unified: unknown[] = [];
      Object.defineProperty(instance, "env", {
        value: {
          AI_GATEWAY_API_KEY: "synthetic-gateway-token",
          AI: {
            gateway: () => ({
              run: async (request: unknown) => {
                unified.push(request);
                return new Response("synthetic unified response");
              },
            }),
          },
        },
      });
      const upstream = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(CONSOLE_LIMIT, { status: 400 }),
        );
      try {
        const first = await instance.fetch(creditRequest());
        expect(first.status).toBe(400);
        expect(await first.text()).toBe(CONSOLE_LIMIT);
        expect(await instance.creditRefusal()).toEqual({
          until: NAMED_UNTIL,
          reason: CONSOLE_LIMIT,
        });

        const refused = await instance.fetch(creditRequest());
        const body = await refused.text();
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(refused.status).toBe(400);
        expect(refused.headers.get("x-cubby-admission-wait")).toBeNull();
        expect(body).toContain("cubby_credit_refused");
        expect(body).toContain("2099-11-01T00:00:00.000Z");
        expect(body).toContain("You have reached your specified API usage");
        expect(isInferenceFundingRefusal(400, body, "subscriber_credit")).toBe(
          true,
        );

        const paid = await instance.fetch(egressRequest({}));
        expect(await paid.text()).toBe("synthetic unified response");
        expect(unified).toHaveLength(1);
      } finally {
        upstream.mockRestore();
      }
    });
  });

  it("holds a refusal without a named date until the window ends", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.parse("2099-10-01T02:00:00Z");
    await stub.noteCreditResponse(400, LOW_BALANCE, now);
    const end = aiBudgetWindow(new Date(now)).end.getTime();
    expect(await stub.creditRefusal(now)).toEqual({
      until: end,
      reason: LOW_BALANCE,
    });
    expect(await stub.admit(CREDIT, end - 1)).toMatchObject({
      kind: "refused",
      until: end,
    });
    expect((await stub.admit(CREDIT, end)).kind).toBe("admitted");
    expect(await stub.creditRefusal(end)).toBeNull();
  });

  it("never records Cubby's own credit-budget stop or a non-funding failure", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.now();
    await stub.noteCreditResponse(
      429,
      '{"error":{"type":"cubby_credit_budget_reached","message":"Claude credit budget reached"}}',
      now,
    );
    await stub.noteCreditResponse(400, "tool_choice is invalid", now);
    expect(await stub.creditRefusal(now)).toBeNull();
    expect((await stub.admit(CREDIT, now)).kind).toBe("admitted");
  });

  it("lets exactly one probe through per window and clears on its success", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.parse("2099-10-01T02:00:00Z");
    await stub.noteCreditResponse(400, CONSOLE_LIMIT, now);
    expect((await stub.admit(CREDIT, now + 1)).kind).toBe("refused");
    const next = aiBudgetWindow(new Date(now)).end.getTime();
    const probe = await stub.admit(CREDIT, next + 1);
    expect(probe.kind).toBe("admitted");
    expect((await stub.admit(CREDIT, next + 2)).kind).toBe("refused");
    if (probe.kind === "admitted")
      await stub.finish(probe.token, 400, null, next + 3);
    // Refused again: re-recorded, and the window's probe stays spent.
    await stub.noteCreditResponse(400, CONSOLE_LIMIT, next + 3);
    expect((await stub.admit(CREDIT, next + 4)).kind).toBe("refused");
    const later = await stub.admit(CREDIT, next + SIX_HOURS);
    expect(later.kind).toBe("admitted");
    await stub.noteCreditResponse(200, "", next + SIX_HOURS + 1);
    expect(await stub.creditRefusal(next + SIX_HOURS + 1)).toBeNull();
    expect((await stub.admit(CREDIT, next + SIX_HOURS + 2)).kind).toBe(
      "admitted",
    );
  });

  it("clears on reset and never refuses unified traffic", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.now();
    await stub.noteCreditResponse(400, CONSOLE_LIMIT, now);
    expect((await stub.admit("unified", now)).kind).toBe("admitted");
    expect((await stub.admit(CREDIT, now)).kind).toBe("refused");
    await stub.resetCreditRefusal();
    expect(await stub.creditRefusal(now)).toBeNull();
    expect((await stub.admit(CREDIT, now)).kind).toBe("admitted");
  });
});

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

  // Work paused for free AI capacity must wake at the earliest window end, and
  // no other wake may clear that pending resume.
  it("keeps one funding resume armed at the earliest requested time", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const later = Date.now() + 6 * 60 * 60_000;
    const sooner = later - 60 * 60_000;
    await stub.scheduleFundingResume(later);
    await stub.scheduleFundingResume(sooner);
    await stub.scheduleFundingResume(later);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("fundingResumeAt")).toBe(sooner);
      expect(await state.storage.getAlarm()).toBe(sooner);
    });
  });

  // A recovered Run can exhaust free capacity again while its alarm awaits
  // the database. The old acknowledgement must not erase the next window.
  it.each([false, true])(
    "preserves a funding wake requested during recovery (failure: %s)",
    async (fail) => {
      const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance, state) => {
        const version = "synthetic-funding-recovery";
        Object.defineProperty(instance, "env", {
          value: { CF_VERSION_METADATA: { id: version } },
        });
        await state.storage.put("aiRefreshObservedVersion", version);
        const expired = Date.now() - 1;
        const next = Date.now() + 6 * 60 * 60_000;
        await state.storage.put("fundingResumeAt", expired);
        Object.defineProperty(instance, "recoverFundingRuns", {
          configurable: true,
          value: async () => {
            await instance.scheduleFundingResume(next);
            if (fail) throw new Error("Synthetic recovery failure");
          },
        });
        const outcome = await instance.alarm().then(
          () => "resolved",
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        );
        expect(outcome).toBe(fail ? "Synthetic recovery failure" : "resolved");
        expect(await state.storage.get("fundingResumeAt")).toBe(next);
        if (fail) {
          Object.defineProperty(instance, "recoverFundingRuns", {
            value: async () => {},
          });
          // Direct alarm invocation consumes the scheduled retry as workerd does.
          await state.storage.deleteAlarm();
          await instance.alarm();
        }
        expect(await state.storage.get("fundingResumeAt")).toBe(next);
        expect(
          await state.storage.get("fundingResumeInFlight"),
        ).toBeUndefined();
        expect(await state.storage.getAlarm()).toBe(next);
      });
    },
  );

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

import { isInferenceFundingRefusal } from "@cubby/shared/ai/gateway-request";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it, vi } from "vitest";

import { aiBudgetWindow } from "~/server/ai/budget-window";

import { initializeGatewayEgress } from "../repo/gateway-egress-initialization";
import baseline from "../repo/gateway-egress-migrations/0000_legacy_baseline.sql?raw";
import journal from "../repo/gateway-egress-migrations/meta/_journal.json";

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

describe("Gateway egress schema adoption", () => {
  // Empty-store admission tests cannot catch loss of retained permits, provider
  // refusal epochs, or cooldowns during adoption of existing DOs.
  it("adopts legacy admission state before RPCs and restarts after a subsequent migration", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.parse("2099-10-01T02:00:00Z");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => {
        for (const table of [
          "__drizzle_migrations",
          "starts",
          "permits",
          "cooldowns",
          "typesafe_starts",
          "credit_refusals",
          "credit_epochs",
        ])
          state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
        state.storage.sql.exec(
          "CREATE TABLE starts (bucket TEXT NOT NULL, started INTEGER NOT NULL)",
        );
        state.storage.sql.exec("CREATE INDEX starts_time ON starts(started)");
        state.storage.sql.exec(
          "CREATE TABLE permits (token TEXT PRIMARY KEY, bucket TEXT NOT NULL, deadline INTEGER NOT NULL)",
        );
        state.storage.sql.exec(
          "CREATE TABLE cooldowns (bucket TEXT PRIMARY KEY, until_ms INTEGER NOT NULL)",
        );
        state.storage.sql.exec(
          "CREATE TABLE typesafe_starts (started INTEGER NOT NULL, input_tokens INTEGER NOT NULL)",
        );
        state.storage.sql.exec(
          "CREATE TABLE credit_refusals (bucket TEXT PRIMARY KEY, until_ms INTEGER NOT NULL, reason TEXT NOT NULL, probe_window INTEGER NOT NULL)",
        );
        state.storage.sql.exec(
          "CREATE TABLE credit_epochs (bucket TEXT PRIMARY KEY, epoch INTEGER NOT NULL)",
        );
        for (let index = 0; index < 64; index++) {
          state.storage.sql.exec(
            "INSERT INTO starts VALUES ('unified', ?)",
            now,
          );
          state.storage.sql.exec(
            "INSERT INTO permits VALUES (?, 'unified', ?)",
            `legacy-${index}`,
            now + 60_000,
          );
        }
        state.storage.sql.exec(
          "INSERT INTO cooldowns VALUES ('synthetic-cooldown', ?)",
          now + 30_000,
        );
        state.storage.sql.exec(
          "INSERT INTO typesafe_starts VALUES (?, 80000)",
          now,
        );
        state.storage.sql.exec(
          "INSERT INTO credit_refusals VALUES (?, ?, ?, ?)",
          CREDIT,
          NAMED_UNTIL,
          CONSOLE_LIMIT,
          aiBudgetWindow(new Date(now)).start.getTime(),
        );
        state.storage.sql.exec(
          "INSERT INTO credit_epochs VALUES (?, 7)",
          CREDIT,
        );
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);
    expect(
      await Promise.all([
        stub.admit("unified", now),
        stub.admit("byok:typesafe", now),
        stub.admit("synthetic-cooldown", now),
        stub.admit(CREDIT, now),
      ]),
    ).toEqual([
      { kind: "wait", until: now + 1_000 },
      expect.objectContaining({ kind: "admitted" }),
      { kind: "wait", until: now + 30_000 },
      { kind: "refused", until: NAMED_UNTIL, reason: CONSOLE_LIMIT },
    ]);
    await runInDurableObject(stub, (instance) =>
      instance.noteCreditResponse(200, "", now, 6),
    );
    expect(await stub.creditRefusal(now)).toEqual({
      until: NAMED_UNTIL,
      reason: CONSOLE_LIMIT,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(
        state.storage.sql.exec("PRAGMA index_info('starts_time')").toArray(),
      ).toMatchObject([{ name: "started" }]);
      expect(
        state.storage.sql
          .exec("SELECT epoch FROM credit_epochs WHERE bucket = ?", CREDIT)
          .toArray(),
      ).toEqual([{ epoch: 7 }]);
      const entry = journal.entries[0];
      if (!entry) throw new Error("Baseline migration missing");
      await migrate(drizzle(state.storage), {
        journal: {
          entries: [
            ...journal.entries,
            {
              ...entry,
              idx: 1,
              when: entry.when + 1,
              tag: "synthetic_upgrade",
            },
          ],
        },
        migrations: {
          m0000: baseline,
          m0001:
            "ALTER TABLE credit_refusals ADD COLUMN synthetic_revision TEXT",
        },
      });
    });
    await evictDurableObject(stub);
    await stub.finish("legacy-0", 200, null, now);
    expect((await stub.admit("unified", now)).kind).toBe("admitted");
    await stub.resetCreditRefusal();
    expect(await stub.admit(CREDIT, now)).toMatchObject({
      kind: "admitted",
      epoch: 8,
    });
    await evictDurableObject(stub);
    expect(await stub.creditRefusal(now)).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM typesafe_starts").toArray(),
      ).toEqual([{ started: now, input_tokens: 80000 }]);
      expect(
        state.storage.sql.exec("SELECT DISTINCT bucket FROM starts").toArray(),
      ).toEqual([{ bucket: "unified" }]);
      expect(
        state.storage.sql
          .exec("SELECT created_at FROM __drizzle_migrations")
          .toArray(),
      ).toHaveLength(2);
      expect(
        state.storage.sql
          .exec("PRAGMA table_info('credit_refusals')")
          .toArray(),
      ).toContainEqual(expect.objectContaining({ name: "synthetic_revision" }));
    });
  });

  it.each(["table", "index"])(
    "rejects an incompatible legacy %s before adoption and gates admission on failure",
    async (legacyObject) => {
      const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
      const error =
        legacyObject === "table"
          ? "Incompatible AI Gateway egress legacy table: credit_epochs"
          : "Incompatible AI Gateway egress legacy index: starts_time";
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TABLE __drizzle_migrations");
        state.storage.sql.exec(
          "INSERT INTO credit_epochs VALUES (?, 7)",
          CREDIT,
        );
        if (legacyObject === "table")
          state.storage.sql.exec(
            "ALTER TABLE credit_epochs RENAME COLUMN epoch TO incompatible_epoch",
          );
        else {
          state.storage.sql.exec("DROP INDEX starts_time");
          state.storage.sql.exec("CREATE INDEX starts_time ON starts(bucket)");
        }
        await expect(initializeGatewayEgress(state.storage)).rejects.toThrow(
          error,
        );
        expect(
          state.storage.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'",
            )
            .toArray(),
        ).toEqual([]);
        expect(
          state.storage.sql.exec("SELECT bucket FROM credit_epochs").toArray(),
        ).toEqual([{ bucket: CREDIT }]);
      });
      await evictDurableObject(stub);
      const startupError = await stub.admit(CREDIT).then(
        () => "resolved",
        (error: unknown) => String(error),
      );
      expect(startupError).toContain(error);
    },
  );
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

// Regression: a credit request in flight across "Retry Claude credit now"
// re-recorded the refusal it had cleared; an older success cleared a newer
// refusal; and long refusal bodies lost their tail.
describe("credit refusal observations", () => {
  it("ignores a response admitted before the latest reset", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.now();
    const inFlight = await stub.admit(CREDIT, now);
    if (inFlight.kind !== "admitted") throw new Error("Expected admission");
    await stub.resetCreditRefusal();
    await stub.noteCreditResponse(400, CONSOLE_LIMIT, now + 1, inFlight.epoch);
    expect(await stub.creditRefusal(now + 1)).toBeNull();
  });

  it("keeps a refusal recorded after an older request was admitted", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.now();
    const older = await stub.admit(CREDIT, now);
    const newer = await stub.admit(CREDIT, now);
    if (older.kind !== "admitted" || newer.kind !== "admitted")
      throw new Error("Expected admissions");
    await stub.noteCreditResponse(400, CONSOLE_LIMIT, now + 1, newer.epoch);
    await stub.noteCreditResponse(200, "", now + 2, older.epoch);
    expect(await stub.creditRefusal(now + 2)).not.toBeNull();
  });

  it("retains the whole refusal body and reads its date past 4 KB", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.parse("2099-10-01T02:00:00Z");
    const body = `${"x".repeat(5_000)} ${CONSOLE_LIMIT}`;
    await stub.noteCreditResponse(400, body, now);
    const refusal = await stub.creditRefusal(now);
    expect(refusal).toEqual({ until: NAMED_UNTIL, reason: body });
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

  it("shares the aggregate budget and cooldown across callers without spending capacity on a refusal", async () => {
    const name = crypto.randomUUID();
    const first = env.AI_GATEWAY_EGRESS.getByName(name);
    const second = env.AI_GATEWAY_EGRESS.getByName(name);
    const now = Date.now();
    const tokens: string[] = [];
    for (let i = 0; i < 64; i++) {
      const admitted = await first.admit("unified", now);
      expect(admitted.kind).toBe("admitted");
      if (admitted.kind === "admitted") tokens.push(admitted.token);
    }
    expect(await second.admit("unified", now)).toMatchObject({ kind: "wait" });
    expect((await second.admit(CREDIT, now)).kind).toBe("admitted");
    await second.finish(tokens[0]!, 429, "60", now);
    expect(await first.admit("unified", now + 1)).toMatchObject({
      kind: "wait",
      until: now + 60_000,
    });
    for (const token of tokens.slice(1))
      await first.finish(token, 200, null, now);
    expect((await second.admit("unified", now + 60_001)).kind).toBe("admitted");
  });
  // Capacity evidence counts actual requests, independently of how many
  // questions the shared decision runner consolidates into each request.
  it("admits 180 starts within a minute with ten-second model latency", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    const now = Date.now();
    let starts = 0;
    let peak = 0;
    const refusals: Awaited<ReturnType<typeof stub.admit>>[] = [];
    for (let elapsed = 0; elapsed < 60_000; elapsed += 10_000) {
      const tokens: string[] = [];
      for (let request = 0; request < 64; request++) {
        const admission = await stub.admit("unified", now + elapsed);
        if (admission.kind === "admitted") tokens.push(admission.token);
        else {
          refusals.push(admission);
          break;
        }
      }
      starts += tokens.length;
      peak = Math.max(peak, tokens.length);
      for (const token of tokens)
        await stub.finish(token, 200, null, now + elapsed + 10_000);
    }
    for (const refusal of refusals)
      expect(refusal).toEqual({ kind: "wait", until: now + 60_000 });
    expect(peak).toBeGreaterThanOrEqual(30);
    expect(starts).toBe(180);
    expect(await stub.admit("unified", now + 59_999)).toEqual({
      kind: "wait",
      until: now + 60_000,
    });
    expect((await stub.admit("unified", now + 60_000)).kind).toBe("admitted");
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

describe("Jev BYOK egress", () => {
  it("uses stored TypeSafe credentials without consuming Unified Billing or inheriting its cooldown", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance) => {
      Object.defineProperty(instance, "env", {
        value: { AI_GATEWAY_API_KEY: "synthetic-gateway-key" },
      });
      const unified = await instance.admit("unified");
      expect(unified.kind).toBe("admitted");
      if (unified.kind !== "admitted") throw new Error("Expected permit");
      await instance.finish(unified.token, 429, "60");
      const upstream = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response('{"answers":{}}'));
      try {
        const request = new Request("https://gateway.internal/egress", {
          method: "POST",
          body: JSON.stringify({
            provider: "workers-ai",
            endpoint: "run/typesafe/jev",
            query: { state: "synthetic", questions: {} },
            controls: {
              metadata: {
                environment: "production",
                feature: "field-suggestion",
                operation: "synthetic",
              },
            },
          }),
        });
        const response = await instance.fetch(request);
        expect(response.status).toBe(200);
        await response.text();
        expect(upstream).toHaveBeenCalledOnce();
        expect(upstream.mock.calls[0]?.[0]).toEqual(
          expect.stringMatching(/\/ai\/run$/),
        );
        const init = upstream.mock.calls[0]?.[1];
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer synthetic-gateway-key",
        );
        expect(new Headers(init?.headers).get("cf-aig-no-wholesale")).toBe(
          "true",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "typesafe/jev",
          input: { state: "synthetic", questions: {} },
        });
        expect((await instance.admit("unified")).kind).toBe("wait");
      } finally {
        upstream.mockRestore();
      }
    });
  });

  it("admits Jev bursts without speculative caps and shares only its provider cooldown", async () => {
    const name = crypto.randomUUID();
    const first = env.AI_GATEWAY_EGRESS.getByName(name);
    const second = env.AI_GATEWAY_EGRESS.getByName(name);
    const now = Date.now();
    const permits: string[] = [];
    for (let index = 0; index < 80; index++) {
      const admitted = await first.admit("byok:typesafe", now);
      expect(admitted.kind).toBe("admitted");
      if (admitted.kind === "admitted") permits.push(admitted.token);
    }
    await first.finish(permits[0]!, 429, "2", now);
    expect(await second.admit("byok:typesafe", now + 1)).toEqual({
      kind: "wait",
      until: now + 2_000,
    });
    expect((await second.admit("unified", now + 1)).kind).toBe("admitted");
    // Finishing an older success must not erase a later provider cooldown.
    await second.finish(permits[1]!, 200, null, now + 1);
    expect((await first.admit("byok:typesafe", now + 1)).kind).toBe("wait");
    expect((await first.admit("byok:typesafe", now + 2_000)).kind).toBe(
      "admitted",
    );
  });
});

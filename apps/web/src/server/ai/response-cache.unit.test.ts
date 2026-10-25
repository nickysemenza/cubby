import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as cfEnv from "~/server/cf-env";
import {
  withJobExecution,
  withJobBatchExecution,
} from "~/server/generic/jobs/context";
import { JobDeferredError } from "~/server/generic/jobs/errors";

import {
  AiResponseCacheBatch,
  aiResponseCacheKey,
  withAiResponseCache,
} from "./response-cache";

const input = (name: string) => ({
  feature: "test",
  model: "test",
  promptVersion: "1",
  input: {
    state: name,
    questions: {
      selection: {
        type: "choice" as const,
        instructions: "Choose one.",
        criteria: { c0: "one", c1: "two" },
      },
    },
  },
});
const validate = z.object({ choice: z.string() }).parse;

describe("AI response cache", () => {
  // Cold-cache request growth consumes an instance budget even with bounded decisions.
  it("uses one claim and one publication for a cold synthetic decision", async () => {
    const calls: string[] = [];
    const namespace = fromPartial<
      NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
    >({
      getByName: () =>
        fromPartial({
          readOrClaim: async () => {
            calls.push("claim");
            return { kind: "claimed", token: "synthetic-lease" };
          },
          publish: async () => {
            calls.push("publish");
            return true;
          },
          renew: async () => {
            calls.push("renew");
            return true;
          },
        }),
    });
    const mock = vi
      .spyOn(cfEnv, "getAiResponseCacheNamespace")
      .mockReturnValue(namespace);
    try {
      await withAiResponseCache({
        enabled: true,
        keyInput: input("synthetic-cold-transport"),
        validate,
        compute: async () => {
          calls.push("gateway");
          return { choice: "one" };
        },
      });
      expect(calls).toEqual(["claim", "gateway", "publish"]);
    } finally {
      mock.mockRestore();
    }
  });

  // An entry this code rejects is replaced through the claim protocol, so
  // concurrent readers wait for the replacement instead of racing deletes.
  it("replaces an invalid entry through one forced claim", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ kind: "hit", value: "{}" })
      .mockResolvedValue({ kind: "claimed", token: "synthetic-claim" });
    const publish = vi.fn(async () => true);
    const namespace = fromPartial<
      NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
    >({
      getByName: () => fromPartial({ readOrClaim: read, publish }),
    });
    const mock = vi
      .spyOn(cfEnv, "getAiResponseCacheNamespace")
      .mockReturnValue(namespace);
    const compute = vi.fn(async () => ({ choice: "one" }));
    try {
      expect(
        await withAiResponseCache({
          enabled: true,
          keyInput: input("synthetic-invalid-entry"),
          validate,
          compute,
        }),
      ).toEqual({ choice: "one" });
      expect(read.mock.calls.map(([, force]) => force)).toEqual([false, true]);
      expect(compute).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      mock.mockRestore();
    }
  });

  // Regression: an unreachable cache fell through to an uncached paid call.
  it("never places an uncached provider call when the cache is unreachable", async () => {
    const outage = new Error("synthetic cache outage");
    const namespace = fromPartial<
      NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
    >({
      getByName: () =>
        fromPartial({ readOrClaim: vi.fn().mockRejectedValue(outage) }),
    });
    const mock = vi
      .spyOn(cfEnv, "getAiResponseCacheNamespace")
      .mockReturnValue(namespace);
    const compute = vi.fn();
    const run = () =>
      withAiResponseCache({
        enabled: true,
        keyInput: input("synthetic-cache-outage"),
        validate,
        compute,
      });
    try {
      await expect(run()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof JobDeferredError && error.cause === outage,
      );
      expect(compute).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });

  // Regression: an interactive wait that outlived its deadline paid for an
  // uncached duplicate of the in-flight answer.
  it("fails an interactive wait at its deadline without an uncached call", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => ({ kind: "busy" }));
    const namespace = fromPartial<
      NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
    >({
      getByName: () => fromPartial({ readOrClaim: read }),
    });
    const mock = vi
      .spyOn(cfEnv, "getAiResponseCacheNamespace")
      .mockReturnValue(namespace);
    const compute = vi.fn();
    try {
      const result = withAiResponseCache({
        enabled: true,
        keyInput: input("synthetic-busy-deadline"),
        validate,
        compute,
      });
      // Observed below; this only keeps the pending rejection handled.
      result.catch(() => undefined);
      // WebCrypto hashing finishes on the real event loop before the wait starts.
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await expect(result).rejects.toThrow("still computing");
      expect(compute).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
      vi.useRealTimers();
    }
  });

  // A contended cache lease defers a job page instead of polling inside it.
  it.each(["single", "batch"])(
    "defers a %s job page on its first contended cache lookup",
    async (scope) => {
      const read = vi
        .fn()
        .mockReturnValueOnce({ kind: "busy" })
        .mockReturnValue({ kind: "hit", value: '{"choice":"one"}' });
      const namespace = fromPartial<
        NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
      >({
        getByName: () => fromPartial({ readOrClaim: read }),
      });
      const mock = vi
        .spyOn(cfEnv, "getAiResponseCacheNamespace")
        .mockReturnValue(namespace);
      const compute = vi.fn();
      try {
        const prepare = () =>
          withAiResponseCache({
            enabled: true,
            keyInput: input(`synthetic-job-contention-${scope}`),
            validate,
            compute,
          });
        await expect(
          scope === "batch"
            ? withJobBatchExecution(prepare)
            : withJobExecution(fromPartial({}), fromPartial({}), prepare),
        ).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof JobDeferredError &&
            error.until.getTime() - Date.now() >= 14_000,
        );
        expect(read).toHaveBeenCalledOnce();
        expect(compute).not.toHaveBeenCalled();
      } finally {
        mock.mockRestore();
      }
    },
  );

  // A full group's pair reads must be bounded by shards/chunks, not candidate count.
  it("batches 240 cache lookups and reuses hits while handling misses", async () => {
    const { getAiResponseCacheNamespace } = await import("~/server/cf-env");
    const namespace = getAiResponseCacheNamespace();
    expect(namespace).toBeUndefined();
    const inputs = Array.from({ length: 240 }, (_, index) =>
      input(`batch-${crypto.randomUUID()}-${index}`),
    );
    const compute = vi.fn(async () => ({ choice: "one" }));
    const run = () => {
      const batch = new AiResponseCacheBatch(inputs.length);
      return Promise.all(
        inputs.map((keyInput, index) =>
          withAiResponseCache({
            enabled: true,
            keyInput,
            validate,
            compute,
            batch: { batch, index },
          }),
        ),
      );
    };
    expect(await run()).toEqual(
      Array.from({ length: 240 }, () => ({ choice: "one" })),
    );
    expect(compute).toHaveBeenCalledTimes(240);
    await run();
    expect(compute).toHaveBeenCalledTimes(240);
  });

  it("uses at most 64 shard reads for a 240-pair group", async () => {
    const read = vi.fn(
      async (requests: readonly { key: string; force: boolean }[]) => {
        expect(requests.length).toBeLessThanOrEqual(128);
        return requests.map(() => ({
          kind: "hit" as const,
          value: JSON.stringify({ choice: "one" }),
        }));
      },
    );
    const single = vi.fn();
    const namespace = fromPartial<
      NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
    >({
      getByName: () =>
        fromPartial({ readOrClaimMany: read, readOrClaim: single }),
    });
    const mock = vi
      .spyOn(cfEnv, "getAiResponseCacheNamespace")
      .mockReturnValue(namespace);
    try {
      const batch = new AiResponseCacheBatch(240);
      const compute = vi.fn();
      const results = await Promise.all(
        Array.from({ length: 240 }, (_, index) =>
          withAiResponseCache({
            enabled: true,
            keyInput: input(`bounded-${index}`),
            validate,
            compute,
            batch: { batch, index },
          }),
        ),
      );
      expect(results).toHaveLength(240);
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.length).toBeLessThanOrEqual(64);
      expect(single).not.toHaveBeenCalled();
      expect(compute).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });

  it("keys the effective input while preserving choice order", async () => {
    const a = await aiResponseCacheKey(input("alpha"));
    const b = await aiResponseCacheKey({
      promptVersion: "1",
      model: "test",
      feature: "test",
      input: {
        questions: {
          selection: {
            criteria: { c1: "two", c0: "one" },
            instructions: "Choose one.",
            type: "choice",
          },
        },
        state: "alpha",
      },
    });
    expect(a).toBe(b);
    expect(
      await aiResponseCacheKey({ ...input("alpha"), effort: undefined }),
    ).toBe(a);
    expect(await aiResponseCacheKey(input("alpha"))).not.toBe(
      await aiResponseCacheKey({
        ...input("alpha"),
        input: {
          ...input("alpha").input,
          questions: {
            selection: {
              ...input("alpha").input.questions.selection,
              criteria: { c0: "two", c1: "one" },
            },
          },
        },
      }),
    );
    expect(
      await aiResponseCacheKey({ ...input("alpha"), promptVersion: "2" }),
    ).not.toBe(await aiResponseCacheKey(input("alpha")));
  });

  it("shares simultaneous work, reuses success, and refreshes when forced", async () => {
    const keyInput = input(crypto.randomUUID());
    let finish!: (value: { choice: string }) => void;
    const pending = new Promise<{ choice: string }>((resolve) => {
      finish = resolve;
    });
    const compute = vi.fn(async () => pending);
    const args = { enabled: true, keyInput, validate, compute };
    const first = withAiResponseCache(args);
    const second = withAiResponseCache(args);
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    finish({ choice: "one" });
    expect(await first).toEqual({ choice: "one" });
    expect(await second).toEqual({ choice: "one" });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await withAiResponseCache(args)).toEqual({ choice: "one" });
    const refreshed = await withAiResponseCache({
      ...args,
      force: true,
      compute: async () => ({ choice: "two" }),
    });
    expect(refreshed).toEqual({ choice: "two" });
    expect(await withAiResponseCache(args)).toEqual({ choice: "two" });
  });

  it("keeps the previous answer when a forced regeneration fails", async () => {
    const keyInput = input(crypto.randomUUID());
    const args = { enabled: true, keyInput, validate };
    await withAiResponseCache({
      ...args,
      compute: async () => ({ choice: "one" }),
    });
    await expect(
      withAiResponseCache({
        ...args,
        force: true,
        compute: async () => {
          throw new Error("429");
        },
      }),
    ).rejects.toThrow("429");
    const compute = vi.fn();
    expect(await withAiResponseCache({ ...args, compute })).toEqual({
      choice: "one",
    });
    expect(compute).not.toHaveBeenCalled();
  });

  // A hit's standard comparison prices the inference its entry avoided, so
  // every call that produced the answer travels with the entry.
  it("hands a hit the usage of every call that produced its entry", async () => {
    const keyInput = input(crypto.randomUUID());
    const onHit = vi.fn(async () => undefined);
    const args = { enabled: true, keyInput, validate, onHit };
    await withAiResponseCache({
      ...args,
      compute: async (_status, recordUsage) => {
        recordUsage({ inputTokens: 100, outputTokens: 10 });
        recordUsage({ inputTokens: 50, outputTokens: null });
        return { choice: "one" };
      },
    });
    expect(onHit).not.toHaveBeenCalled();
    expect(await withAiResponseCache({ ...args, compute: vi.fn() })).toEqual({
      choice: "one",
    });
    expect(onHit).toHaveBeenCalledWith(expect.any(Number), {
      inputTokens: 150,
      outputTokens: 10,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  // Entries published before usage retention stay valid answers.
  it("replays a bare legacy entry with unknown avoided usage", async () => {
    const namespace = fromPartial<
      NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
    >({
      getByName: () =>
        fromPartial({
          readOrClaim: () => ({
            kind: "hit" as const,
            value: '{"choice":"legacy"}',
          }),
        }),
    });
    vi.spyOn(cfEnv, "getAiResponseCacheNamespace").mockReturnValue(namespace);
    const onHit = vi.fn(async () => undefined);
    const compute = vi.fn();
    expect(
      await withAiResponseCache({
        enabled: true,
        keyInput: input(crypto.randomUUID()),
        validate,
        compute,
        onHit,
      }),
    ).toEqual({ choice: "legacy" });
    expect(compute).not.toHaveBeenCalled();
    expect(onHit).toHaveBeenCalledWith(expect.any(Number), null);
    vi.restoreAllMocks();
  });

  it("does not retain failures or invalid answers", async () => {
    const keyInput = input(crypto.randomUUID());
    await expect(
      withAiResponseCache({
        enabled: true,
        keyInput,
        validate,
        compute: async () => {
          throw new Error("429");
        },
      }),
    ).rejects.toThrow("429");
    await expect(
      withAiResponseCache({
        enabled: true,
        keyInput,
        validate,
        compute: async () => JSON.parse('{"choice":7}'),
      }),
    ).rejects.toThrow("Invalid input: expected string");
    expect(
      await withAiResponseCache({
        enabled: true,
        keyInput,
        validate,
        compute: async () => ({ choice: "one" }),
      }),
    ).toEqual({ choice: "one" });
  });

  // Regression: answers above one storage row were released uncached and
  // every identical call paid again.
  it("replays an answer larger than one storage row", async () => {
    const keyInput = input(crypto.randomUUID());
    const huge = "x".repeat(1_000_001);
    const args = { enabled: true, keyInput, validate };
    await withAiResponseCache({
      ...args,
      compute: async () => ({ choice: huge }),
    });
    const compute = vi.fn();
    expect(await withAiResponseCache({ ...args, compute })).toEqual({
      choice: huge,
    });
    expect(compute).not.toHaveBeenCalled();
  });

  // A paid answer whose write fails is not reported as success, and its
  // retry writes the kept answer instead of paying for it again.
  it("keeps an unwritten answer for a retry without another model call", async () => {
    const outage = new Error("synthetic write outage");
    const publish = vi
      .fn()
      .mockRejectedValueOnce(outage)
      .mockRejectedValueOnce(outage)
      .mockRejectedValueOnce(outage)
      .mockResolvedValue(true);
    const namespace = fromPartial<
      NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
    >({
      getByName: () =>
        fromPartial({
          readOrClaim: () => ({ kind: "claimed" as const, token: "lease" }),
          publish,
        }),
    });
    const mock = vi
      .spyOn(cfEnv, "getAiResponseCacheNamespace")
      .mockReturnValue(namespace);
    const compute = vi.fn(async () => ({ choice: "one" }));
    const args = {
      enabled: true,
      keyInput: input(`unwritten-${crypto.randomUUID()}`),
      validate,
      compute,
    };
    try {
      await expect(withAiResponseCache(args)).rejects.toSatisfy(
        (error: unknown) => error instanceof Error && error.cause === outage,
      );
      expect(await withAiResponseCache(args)).toEqual({ choice: "one" });
      expect(compute).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledTimes(4);
    } finally {
      mock.mockRestore();
    }
  });

  // A reported answer is reusable: its cache write lands before the caller
  // sees success instead of trailing the response.
  it("persists a new answer before reporting it", async () => {
    let land!: (written: boolean) => void;
    const publish = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          land = resolve;
        }),
    );
    const namespace = fromPartial<
      NonNullable<ReturnType<typeof cfEnv.getAiResponseCacheNamespace>>
    >({
      getByName: () =>
        fromPartial({
          readOrClaim: () => ({ kind: "claimed" as const, token: "lease" }),
          publish,
        }),
    });
    const mock = vi
      .spyOn(cfEnv, "getAiResponseCacheNamespace")
      .mockReturnValue(namespace);
    const deferred: Promise<unknown>[] = [];
    let answered = false;
    try {
      const result = cfEnv
        .runWithExecutionCtx({ waitUntil: (task) => deferred.push(task) }, () =>
          withAiResponseCache({
            enabled: true,
            keyInput: input(`persisted-${crypto.randomUUID()}`),
            validate,
            compute: async () => ({ choice: "one" }),
          }),
        )
        .then((value) => {
          answered = true;
          return value;
        });
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
      expect(answered).toBe(false);
      land(true);
      expect(await result).toEqual({ choice: "one" });
      expect(deferred).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });
});

import type { BatchOut } from "@cubby/schemas/batch";
import { sleep } from "@cubby/shared/retry";
import { describe, expect, it, vi } from "vitest";

import { createRequestBatcher } from "./request-batcher";

type Item = { id: string };
const input = (id: string): Item => ({ id });
const echo = vi.fn(async (items: Item[]): Promise<BatchOut<string>> => ({
  results: items.map((item) => ({ ok: true, value: `answer:${item.id}` })),
}));

const live = () => new AbortController().signal;

describe("request batcher", () => {
  it("answers rows requested in the same tick with one request, in order", async () => {
    const send = vi.fn(echo);
    const batcher = createRequestBatcher(send);
    const results = await Promise.all(
      ["EXP-A", "EXP-B", "EXP-C"].map((id) => batcher.load(input(id), live())),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].map((item) => item.id)).toEqual([
      "EXP-A",
      "EXP-B",
      "EXP-C",
    ]);
    expect(results).toEqual(["answer:EXP-A", "answer:EXP-B", "answer:EXP-C"]);
  });

  it("splits a burst larger than the cap into several requests", async () => {
    const send = vi.fn(echo);
    const batcher = createRequestBatcher(send, { max: 2 });
    await Promise.all(
      ["A", "B", "C", "D", "E"].map((id) => batcher.load(input(id), live())),
    );
    expect(send.mock.calls.map(([items]) => items.length)).toEqual([2, 2, 1]);
  });

  it("rejects only the row whose item failed", async () => {
    const batcher = createRequestBatcher(
      async (items: Item[]): Promise<BatchOut<string>> => ({
        results: items.map((item) =>
          item.id === "EXP-B"
            ? { ok: false, message: 'relation "Project" does not exist' }
            : { ok: true, value: item.id },
        ),
      }),
    );
    const [a, b] = await Promise.allSettled([
      batcher.load(input("EXP-A"), live()),
      batcher.load(input("EXP-B"), live()),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({
      status: "rejected",
      reason: { message: 'relation "Project" does not exist' },
    });
  });

  it("rejects every row when the request itself fails", async () => {
    const batcher = createRequestBatcher<Item, string>(async () => {
      throw new Error("Timed out while waiting for an open slot in the pool");
    });
    const settled = await Promise.allSettled([
      batcher.load(input("EXP-A"), live()),
      batcher.load(input("EXP-B"), live()),
    ]);
    expect(settled.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });

  it("drops a row cancelled before the batch is sent", async () => {
    const send = vi.fn(echo);
    const batcher = createRequestBatcher(send);
    const cancelled = new AbortController();
    const dropped = batcher.load(input("EXP-A"), cancelled.signal);
    const kept = batcher.load(input("EXP-B"), live());
    cancelled.abort();
    await expect(dropped).rejects.toMatchObject({ name: "AbortError" });
    await kept;
    expect(send.mock.calls[0]![0].map((item) => item.id)).toEqual(["EXP-B"]);
  });

  it("aborts the request once every row in it is cancelled", async () => {
    let requestSignal: AbortSignal | undefined;
    const batcher = createRequestBatcher<Item, string>(
      (_items, signal) =>
        new Promise((_resolve, reject) => {
          requestSignal = signal;
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const controllers = [new AbortController(), new AbortController()];
    const rows = controllers.map((controller, index) =>
      batcher.load(input(`EXP-${index}`), controller.signal),
    );
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controllers[0]!.abort();
    expect(requestSignal!.aborted).toBe(false);
    controllers[1]!.abort();
    expect(requestSignal!.aborted).toBe(true);
    await expect(Promise.allSettled(rows)).resolves.toHaveLength(2);
  });

  it("resolves a streamed item before the rest of its batch finishes", async () => {
    let finish!: () => void;
    const batcher = createRequestBatcher<Item, string>(
      async (_items, _signal, deliver) => {
        deliver(1, { ok: true, value: "fast" });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        deliver(0, { ok: true, value: "slow" });
      },
    );
    const slow = batcher.load(input("slow"), live());
    const fast = await batcher.load(input("fast"), live());
    expect(fast).toBe("fast");
    finish();
    await expect(slow).resolves.toBe("slow");
  });

  it("rejects items a stream never delivered", async () => {
    const batcher = createRequestBatcher<Item, string>(
      async (_items, _signal, deliver) => {
        deliver(0, { ok: true, value: "only" });
      },
    );
    const settled = await Promise.allSettled([
      batcher.load(input("a"), live()),
      batcher.load(input("b"), live()),
    ]);
    expect(settled[0]).toMatchObject({ status: "fulfilled" });
    expect(settled[1]).toMatchObject({
      status: "rejected",
      reason: { message: "Batch omitted this item" },
    });
  });

  // Failure: a lone item queued behind full batches (slow suggestion batches,
  // say) waits for a slot it never needed — a typed search stalls behind them.
  it("sends a lone item through sendOne without waiting for a slot", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batcher = createRequestBatcher<Item, string>(
      async (items) => {
        await held;
        return echo(items);
      },
      {
        concurrency: 1,
        sendOne: async (item) => `alone:${item.id}`,
      },
    );
    const blocked = Promise.all([
      batcher.load(input("a"), live()),
      batcher.load(input("b"), live()),
    ]);
    await sleep(0);
    await expect(batcher.load(input("search"), live())).resolves.toBe(
      "alone:search",
    );
    release();
    await blocked;
  });

  it("never runs more requests at once than its limit", async () => {
    let active = 0;
    let peak = 0;
    const batcher = createRequestBatcher(
      async (items: Item[]) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5);
        active -= 1;
        return echo(items);
      },
      { max: 1, concurrency: 2 },
    );
    await Promise.all(
      ["A", "B", "C", "D", "E"].map((id) => batcher.load(input(id), live())),
    );
    expect(peak).toBe(2);
  });
});

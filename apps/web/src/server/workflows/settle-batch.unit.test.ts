import { sleep } from "@cubby/shared/retry";
import { describe, expect, it } from "vitest";

import { settleBatch } from "./settle-batch";

describe("settleBatch", () => {
  it("keeps results positional when items finish out of order", async () => {
    const delays = [15, 1, 8, 3];
    const out = await settleBatch(delays, async (delay, index) => {
      await sleep(delay);
      return index;
    });
    expect(out.results).toEqual(
      delays.map((_, index) => ({ ok: true, value: index })),
    );
  });

  it("turns one item's error into its own result with the raw message", async () => {
    const out = await settleBatch(["a", "b"], async (item) => {
      if (item === "b") throw new Error('duplicate key value violates "uq"');
      return item;
    });
    expect(out.results).toEqual([
      { ok: true, value: "a" },
      { ok: false, message: 'duplicate key value violates "uq"' },
    ]);
  });

  it("reports each item as it settles, in finish order", async () => {
    const order: number[] = [];
    await settleBatch(
      [10, 1],
      async (delay) => {
        await sleep(delay);
      },
      { onSettled: (index) => order.push(index) },
    );
    expect(order).toEqual([1, 0]);
  });

  it("never runs more items at once than its concurrency", async () => {
    let active = 0;
    let peak = 0;
    await settleBatch(
      Array.from({ length: 10 }, (_, index) => index),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(2);
        active -= 1;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
  });
});

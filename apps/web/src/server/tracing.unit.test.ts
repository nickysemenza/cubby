import { describe, expect, it } from "vitest";
import { traceAllBounded } from "./tracing";

describe("traceAllBounded", () => {
  it("starts no more than the requested number of tasks", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const task = (value: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return value;
    };

    const resultPromise = traceAllBounded(
      {
        one: task(1),
        two: task(2),
        three: task(3),
        four: task(4),
        five: task(5),
      },
      4,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(4);
    expect(maxActive).toBe(4);

    releaseGate();

    await expect(resultPromise).resolves.toEqual({
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
    });
    expect(maxActive).toBe(4);
  });
});

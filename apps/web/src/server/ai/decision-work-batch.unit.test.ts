import { describe, expect, it } from "vitest";

import { settleDecisionWork } from "./decision-work-batch";

// Failure modes: waiting on a model holds a preparation slot and deadlocks the
// batch; a skipped/failed item blocks siblings; dependent decisions never flush.
describe("finite decision work", () => {
  it("rejects a late sibling ask after failure without reviving its owner", async () => {
    const gate = Promise.withResolvers<void>();
    const sent: number[] = [];
    const results = await settleDecisionWork<number, number, number, number>(
      [0, 1],
      async (item, ask) => {
        if (item === 0) {
          const siblings = await Promise.all([
            Promise.reject(new Error("synthetic failed target")),
            gate.promise.then(() => ask(99)),
          ]);
          return siblings[1]!;
        }
        const first = await ask(1);
        gate.resolve();
        const second = await ask(first + 1);
        return ask(second + 1);
      },
      async (questions) => {
        sent.push(...questions);
        return questions.map((value) => ({ status: "fulfilled", value }));
      },
      2,
    );
    expect(results).toEqual([
      { status: "rejected", reason: new Error("synthetic failed target") },
      { status: "fulfilled", value: 3 },
    ]);
    expect(sent).toEqual([1, 2, 3]);
  });
  it("resumes simultaneous asks once per owner without stranding later waves", async () => {
    const results = await settleDecisionWork<number, number, number, number>(
      [1, 2, 3, 4, 5, 6],
      async (value, ask) => {
        const pair = await Promise.all([ask(value), ask(value + 10)]);
        return ask(pair[0]! + pair[1]!);
      },
      async (questions) =>
        questions.map((value) => ({ status: "fulfilled", value })),
      2,
    );
    expect(results).toEqual(
      [1, 2, 3, 4, 5, 6].map((value) => ({
        status: "fulfilled",
        value: value * 2 + 10,
      })),
    );
  });
  it("prepares a bounded set, batches waiting decisions, and resumes dependencies", async () => {
    const batches: number[][] = [];
    const results = await settleDecisionWork<number, number, number, number>(
      [1, 2, 3, 4, 5],
      async (value, ask) => {
        if (value === 2) throw new Error("synthetic preparation failure");
        if (value === 3) return 30;
        const first = await ask(value);
        if (value === 1) return ask(first + 10);
        return first;
      },
      async (questions) => {
        batches.push([...questions]);
        return questions.map((value) => ({
          status: "fulfilled",
          value: value * 2,
        }));
      },
      2,
    );
    expect(batches).toEqual([[1, 4, 5], [12]]);
    expect(results).toEqual([
      { status: "fulfilled", value: 24 },
      {
        status: "rejected",
        reason: new Error("synthetic preparation failure"),
      },
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 8 },
      { status: "fulfilled", value: 10 },
    ]);
  });
});

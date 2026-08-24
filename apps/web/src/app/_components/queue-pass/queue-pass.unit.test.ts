import { describe, expect, it } from "vitest";
import {
  advanceToOutstanding,
  clearSkipped,
  emptyPassProgress,
  isPassComplete,
  isSettled,
  isStoredPassComplete,
  outstandingAfterUnsettling,
  type PassProgress,
  passCounts,
  resolveStops,
  settledIds,
  settleStop,
  unsettleStop,
} from "./queue-pass";

interface Stop {
  id: string;
  name: string;
}

const stops = (...ids: string[]): Stop[] =>
  ids.map((id) => ({ id, name: id.toLowerCase() }));

const progress = (
  completed: string[] = [],
  skipped: string[] = [],
): PassProgress => ({
  completed: new Set(completed),
  skipped: new Set(skipped),
});

describe("settleStop", () => {
  it("records a completion", () => {
    const next = settleStop(emptyPassProgress(), "A", "completed");
    expect([...next.completed]).toEqual(["A"]);
    expect(next.skipped.size).toBe(0);
  });

  it("records a skip", () => {
    const next = settleStop(emptyPassProgress(), "A", "skipped");
    expect([...next.skipped]).toEqual(["A"]);
    expect(next.completed.size).toBe(0);
  });

  // The two sets must stay disjoint or the counts double-count: a bin deferred
  // and later saved is one completion, not one of each.
  it("un-skips a stop that is later completed", () => {
    const next = settleStop(progress([], ["A"]), "A", "completed");
    expect([...next.completed]).toEqual(["A"]);
    expect(next.skipped.size).toBe(0);
  });

  it("un-completes a stop that is later skipped", () => {
    const next = settleStop(progress(["A"]), "A", "skipped");
    expect([...next.skipped]).toEqual(["A"]);
    expect(next.completed.size).toBe(0);
  });

  it("returns the same object when nothing changes", () => {
    const before = progress(["A"]);
    expect(settleStop(before, "A", "completed")).toBe(before);
  });
});

describe("unsettleStop", () => {
  it("returns a completed stop to the outstanding set", () => {
    const next = unsettleStop(progress(["A"]), "A");
    expect(isSettled(next, "A")).toBe(false);
  });

  it("returns a skipped stop to the outstanding set", () => {
    const next = unsettleStop(progress([], ["A"]), "A");
    expect(isSettled(next, "A")).toBe(false);
  });

  it("is a no-op for an outstanding stop", () => {
    const before = emptyPassProgress();
    expect(unsettleStop(before, "A")).toBe(before);
  });
});

describe("clearSkipped", () => {
  it("drops every deferral but keeps completions", () => {
    const next = clearSkipped(progress(["A"], ["B", "C"]));
    expect([...next.completed]).toEqual(["A"]);
    expect(next.skipped.size).toBe(0);
  });

  it("returns the same object when there is nothing deferred", () => {
    const before = progress(["A"]);
    expect(clearSkipped(before)).toBe(before);
  });
});

describe("settledIds", () => {
  it("unions both dispositions", () => {
    expect([...settledIds(progress(["A"], ["B"]))].sort()).toEqual(["A", "B"]);
  });
});

describe("advanceToOutstanding", () => {
  const queue = stops("A", "B", "C");

  it("scans forward to the next outstanding stop", () => {
    expect(advanceToOutstanding(queue, 0, new Set(["A"]))).toBe(1);
  });

  it("skips settled stops on the way forward", () => {
    expect(advanceToOutstanding(queue, 0, new Set(["A", "B"]))).toBe(2);
  });

  it("wraps to an earlier outstanding stop", () => {
    expect(advanceToOutstanding(queue, 2, new Set(["B", "C"]))).toBe(0);
  });

  it("holds position when everything is settled", () => {
    expect(advanceToOutstanding(queue, 1, new Set(["A", "B", "C"]))).toBe(1);
  });

  it("treats a skipped stop as still reachable", () => {
    const settled = settledIds(progress(["B", "C"], []));
    expect(advanceToOutstanding(queue, 2, settled)).toBe(0);
  });
});

describe("outstandingAfterUnsettling", () => {
  const queue = stops("A", "B", "C");

  it("lands on the stop that was returned to the queue", () => {
    expect(outstandingAfterUnsettling(queue, 2, "B")).toBe(1);
  });

  it("holds position for an id that is not in the queue", () => {
    expect(outstandingAfterUnsettling(queue, 2, "ZZ")).toBe(2);
  });
});

describe("isPassComplete", () => {
  it("is false while a stop is outstanding", () => {
    expect(isPassComplete(stops("A"), new Set())).toBe(false);
  });

  it("is true once every stop is settled", () => {
    expect(isPassComplete(stops("A"), new Set(["A"]))).toBe(true);
  });

  it("counts a skip as settled", () => {
    const settled = settledIds(progress([], ["A"]));
    expect(isPassComplete(stops("A"), settled)).toBe(true);
  });

  // An empty queue is "nothing to do", which each flow renders as its own empty
  // state — a summary for a pass that never ran would be a lie.
  it("is false for an empty queue", () => {
    expect(isPassComplete([], new Set())).toBe(false);
  });
});

describe("passCounts", () => {
  it("splits settled into completed and skipped", () => {
    const counts = passCounts(stops("A", "B", "C"), progress(["A"], ["B"]));
    expect(counts).toEqual({
      total: 3,
      completed: 1,
      skipped: 1,
      settled: 2,
      outstanding: 1,
    });
  });

  it("ignores progress for stops outside the queue", () => {
    const counts = passCounts(stops("A"), progress(["A", "OFFSCOPE"]));
    expect(counts.total).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.outstanding).toBe(0);
  });
});

describe("resolveStops", () => {
  const byId = new Map(stops("A", "B", "C").map((s) => [s.id, s]));

  it("preserves the frozen order, not the map order", () => {
    expect(resolveStops(["C", "A"], byId).map((s) => s.id)).toEqual(["C", "A"]);
  });

  // Membership is frozen but content is live: handling a stop must not remove
  // it, or every position after it renumbers mid-pass.
  it("keeps an id whose content no longer matches the entry filter", () => {
    expect(resolveStops(["A", "B", "C"], byId)).toHaveLength(3);
  });

  it("drops an id whose content has gone", () => {
    expect(resolveStops(["A", "GONE"], byId).map((s) => s.id)).toEqual(["A"]);
  });
});

describe("isStoredPassComplete", () => {
  const stored = (completed: string[], skipped: string[] = []) => ({
    completed,
    skipped,
  });

  it("is true when every queued stop is settled", () => {
    expect(isStoredPassComplete(stored(["A", "B"]), ["A", "B"])).toBe(true);
  });

  it("counts a skip as settled", () => {
    expect(isStoredPassComplete(stored(["A"], ["B"]), ["A", "B"])).toBe(true);
  });

  it("is false while a stop is outstanding", () => {
    expect(isStoredPassComplete(stored(["A"]), ["A", "B"])).toBe(false);
  });

  it("is false when the queue has grown past the stored progress", () => {
    expect(isStoredPassComplete(stored(["A", "B"]), ["A", "B", "C"])).toBe(
      false,
    );
  });

  it("ignores stored progress for stops no longer queued", () => {
    expect(isStoredPassComplete(stored(["A", "GONE"]), ["A"])).toBe(true);
  });

  it("is false for an empty queue, matching isPassComplete", () => {
    expect(isStoredPassComplete(stored([]), [])).toBe(false);
  });
});

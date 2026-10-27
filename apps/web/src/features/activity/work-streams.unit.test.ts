import { describe, expect, it } from "vitest";

import type { WorkStream } from "~/contracts/job.contract";

import {
  formatMinutesLeft,
  orderWorkStreams,
  STUCK_AFTER_SECONDS,
  workStreamLabel,
  workStreamView,
} from "./work-streams";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const stream = (overrides: Partial<WorkStream>): WorkStream => ({
  kind: "embedding.refresh",
  running: 0,
  due: 0,
  backingOff: 0,
  scheduled: 0,
  paused: 0,
  completedPerMinute: 0,
  completed: 0,
  failed: 0,
  lastCompletedAt: null,
  oldestDueAt: null,
  runIds: [],
  ...overrides,
});
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe("work streams", () => {
  it("names work in plain words and groups AI evaluations by Job kind", () => {
    expect(workStreamLabel(stream({}))).toBe("Search embeddings");
    expect(workStreamLabel(stream({ kind: "ai.evaluation" }))).toBe(
      "AI evaluations",
    );
    expect(workStreamLabel(stream({ kind: "synthetic.unknown_kind" }))).toBe(
      "Synthetic unknown kind",
    );
  });

  it("reads a moving queue as working and estimates time left from its pace", () => {
    const view = workStreamView(
      stream({ running: 2, due: 98, completedPerMinute: 20 }),
      NOW,
    );
    expect(view.status).toBe("working");
    expect(view.remaining).toBe(100);
    expect(view.minutesLeft).toBe(5);
  });

  it("separates waiting from not moving by the oldest due age and pace", () => {
    const waiting = workStreamView(
      stream({ due: 3, oldestDueAt: ago(60) }),
      NOW,
    );
    const stuck = workStreamView(
      stream({ due: 3, oldestDueAt: ago(STUCK_AFTER_SECONDS) }),
      NOW,
    );
    const slow = workStreamView(
      stream({
        due: 3,
        oldestDueAt: ago(STUCK_AFTER_SECONDS),
        completedPerMinute: 1,
      }),
      NOW,
    );
    expect([waiting.status, stuck.status, slow.status]).toEqual([
      "waiting",
      "stuck",
      "waiting",
    ]);
    expect(stuck.minutesLeft).toBeNull();
  });

  it("orders problems first and finished work last", () => {
    const ordered = orderWorkStreams(
      [
        stream({ kind: "a", completed: 4, lastCompletedAt: ago(30) }),
        stream({ kind: "b", running: 1, due: 5 }),
        stream({ kind: "c", due: 1, oldestDueAt: ago(3600) }),
        stream({ kind: "d", backingOff: 2 }),
        stream({ kind: "e", failed: 3 }),
      ].map((entry) => workStreamView(entry, NOW)),
    );
    expect(ordered.map((view) => view.stream.kind)).toEqual([
      "c",
      "e",
      "b",
      "d",
      "a",
    ]);
  });

  it("keeps failure-only streams actionable rather than done", () => {
    expect(workStreamView(stream({ failed: 3 }), NOW).status).toBe("failed");
  });

  it("formats time left for a household reader", () => {
    expect(formatMinutesLeft(0.4)).toBe("under a minute");
    expect(formatMinutesLeft(12.4)).toBe("about 12 min");
    expect(formatMinutesLeft(300)).toBe("about 5 h");
    expect(formatMinutesLeft(5000)).toBe("about 3 days");
  });
});

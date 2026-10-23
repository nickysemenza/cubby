import {
  readRunWorkPhase,
  runWorkEstimate,
  type RunWorkSamples,
} from "@cubby/schemas/run-work-progress";
import { describe, expect, it } from "vitest";

import { sampleRunWork } from "./work-progress";

describe("Run ETA observations", () => {
  const start = new Date("2026-10-20T12:00:00Z");
  const items = {
    phase: "scan",
    label: "Scanning",
    unit: "items",
    total: 1000,
    failures: 0,
  };
  const sample = (
    previous: RunWorkSamples | undefined,
    processed: number,
    elapsedMs: number,
    reset = false,
  ) =>
    sampleRunWork(
      previous,
      { ...items, processed },
      {
        startedAt: start,
        sampledAt: new Date(start.getTime() + elapsedMs),
        finished: false,
        reset,
        baselineProcessed: reset ? processed : undefined,
      },
    );

  it("keeps costly pages and queue handoffs in the range when the latest page is cheap", () => {
    const first = sample(undefined, 10, 60_000);
    const second = sample(first, 20, 180_000);
    expect(runWorkEstimate(second.current)).toBeNull();
    const third = sample(second, 30, 181_000);
    const range = runWorkEstimate(third.current);
    expect(range).toMatchObject({ samples: 3, confidence: "low" });
    // The 120-second handoff remains represented, rather than projecting the last second.
    expect(range?.upperSeconds).toBeGreaterThan(10_000);
    expect(third.current.ratePerSecond).toBeCloseTo(30 / 181);
    expect(
      readRunWorkPhase(
        third.current,
        "running",
        new Date(start.getTime() + 181_000),
      ).etaSeconds,
    ).toBeGreaterThan(5000);
    expect(
      readRunWorkPhase(
        third.current,
        "paused",
        new Date(start.getTime() + 181_000),
      ).etaSeconds,
    ).toBeNull();
    expect(
      readRunWorkPhase(
        third.current,
        "running",
        new Date(start.getTime() + 400_000),
      ).etaSeconds,
    ).toBeNull();
    expect(
      readRunWorkPhase(
        third.current,
        "running",
        new Date(start.getTime() + 181_000),
        true,
      ).etaSeconds,
    ).toBeNull();
    expect(sample(third, 30, 182_000, true).current.intervals).toEqual([]);
  });

  it("does not turn a historical single-page rate or an unknown population into an ETA", () => {
    const recorded = {
      ...items,
      processed: 30,
      sampledAt: start.toISOString(),
      ratePerSecond: 100,
      finished: false,
    };
    expect(readRunWorkPhase(recorded, "running", start).etaSeconds).toBeNull();
    const third = sample(
      sample(sample(undefined, 10, 1000), 20, 2000),
      30,
      3000,
    );
    expect(runWorkEstimate({ ...third.current, total: null })).toBeNull();
    expect(
      sampleRunWork(
        third,
        { ...items, phase: "label", processed: 0 },
        { startedAt: start, sampledAt: start, finished: false },
      ).current.intervals,
    ).toEqual([]);
  });
});

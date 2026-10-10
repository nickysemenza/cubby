import { describe, expect, it } from "vitest";

import { runPacedBatch } from "./paced-batch";

describe("paced batch Runs", () => {
  it("stops on a persisted pause and resumes at the next target", async () => {
    const processed: number[] = [];
    let paused = false;
    const ports = {
      isPaused: async () => paused,
      saveProgress: async () => undefined,
      wait: async () => undefined,
    };
    const result = await runPacedBatch({
      targets: [1, 2, 3],
      work: async (value) => {
        processed.push(value);
        if (value === 1) paused = true;
        return "queued" as const;
      },
      pacePerMinute: 300,
      ports,
    });
    expect(result.done).toBe(1);
    expect(processed).toEqual([1]);
    paused = false;
    await runPacedBatch({
      targets: [1, 2, 3],
      startAt: result.done,
      work: async (value) => {
        processed.push(value);
        return "queued" as const;
      },
      pacePerMinute: 300,
      ports,
    });
    expect(processed).toEqual([1, 2, 3]);
  });
});

import { makeSweepSuggestion } from "./suggestion-sweep";

const jev = "typesafe/jev" as const;
const clef = "@cf/cloudflare/clef" as const;
describe("sweep decision policy", () => {
  it("queues Corrections at any confidence and applies only high-confidence Additions from the pinned model", () => {
    expect(
      makeSweepSuggestion({
        currentValue: "wrong",
        decision: { value: "right", confidence: 0.99 },
        model: jev,
        pinnedModel: jev,
      })?.status,
    ).toBe("pending");
    expect(
      makeSweepSuggestion({
        currentValue: null,
        decision: { value: "new", confidence: 0.85 },
        model: jev,
        pinnedModel: jev,
      })?.status,
    ).toBe("applied");
    expect(
      makeSweepSuggestion({
        currentValue: "",
        decision: { value: "new", confidence: 0.6 },
        model: jev,
        pinnedModel: jev,
      })?.status,
    ).toBe("pending");
  });

  it("keeps paired rows together and never applies the non-pinned row", () => {
    const pairKey = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const pinned = makeSweepSuggestion({
      currentValue: null,
      decision: { value: "new", confidence: 0.9 },
      model: jev,
      pinnedModel: jev,
      pairKey,
    });
    const paired = makeSweepSuggestion({
      currentValue: null,
      decision: { value: "other", confidence: 0.99 },
      model: clef,
      pinnedModel: jev,
      pairKey,
    });
    expect([pinned?.pairKey, paired?.pairKey]).toEqual([pairKey, pairKey]);
    expect([pinned?.status, paired?.status]).toEqual(["applied", "pending"]);
  });
});

import { problemsCountSchema } from "@cubby/schemas/problems";
import { describe, expect, it, vi } from "vitest";

import { expectedProblemKeys } from "~/entities/problem-registry";

import { resolveProblemCounts } from "./problem-counts.server";

const counts = (total: number) =>
  problemsCountSchema.parse({
    total,
    coverageTotal: total,
    byType: Object.fromEntries(expectedProblemKeys.map((key) => [key, 0])),
  });

describe("problem counts", () => {
  it("prefers a Durable Object snapshot and only falls back when unavailable", async () => {
    const fallback = vi.fn(async () => counts(2));
    await expect(
      resolveProblemCounts(async () => counts(1), fallback),
    ).resolves.toEqual(counts(1));
    expect(fallback).not.toHaveBeenCalled();

    await expect(
      resolveProblemCounts(async () => null, fallback),
    ).resolves.toEqual(counts(2));
    expect(fallback).toHaveBeenCalledOnce();
  });
});

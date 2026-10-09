import { describe, expect, it } from "vitest";

import { gardenGuideKeys } from "./garden-guides";
import {
  gardenCropKeys,
  gardenPractice,
  gardenPracticeEntry,
  gardenPracticeOnlyKeys,
  gardenPracticeSources,
} from "./garden-practice";

describe("garden practice", () => {
  it("covers every crop key and cites only listed sources or an explained estimate", () => {
    expect(Object.keys(gardenPractice).sort()).toEqual(
      [...gardenCropKeys].sort(),
    );
    const sourceIds = new Set(gardenPracticeSources.map((source) => source.id));
    const unsupported = Object.entries(gardenPractice).flatMap(([key, raw]) => {
      const { maturity } = gardenPracticeEntry.parse(raw);
      if (!maturity) return [];
      const supported =
        maturity.source === "estimate"
          ? maturity.note !== undefined
          : sourceIds.has(maturity.source);
      return supported ? [] : [key];
    });
    expect(unsupported).toEqual([]);
  });

  it("names every practice-only crop and never shadows a guide key", () => {
    const unnamed = gardenPracticeOnlyKeys.filter(
      (key) => gardenPractice[key].name === undefined,
    );
    expect(unnamed).toEqual([]);
    const guideKeys = new Set<string>(gardenGuideKeys);
    expect(gardenPracticeOnlyKeys.filter((key) => guideKeys.has(key))).toEqual(
      [],
    );
  });
});

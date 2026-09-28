import { beforeEach, describe, expect, it } from "vitest";

import {
  clearStoredSessionPass,
  listStoredSessionPasses,
} from "./useSessionProgress";

const KEY = (rootId: string) => `cubby:audit-session:${rootId}`;

interface V4PassFixture {
  version: 4;
  startedAt: number;
  updatedAt: number;
  currentIndex: number;
  completed: string[];
  skipped: string[];
  totalCount: number;
  extra: {
    itemResolutions: [];
    summary: {
      adjusted: number;
      locations: number;
      relocated: number;
      removed: number;
      verified: number;
    };
  };
}

beforeEach(() => {
  localStorage.clear();
});

const v4 = (overrides: Partial<V4PassFixture> = {}) =>
  JSON.stringify({
    version: 4,
    startedAt: 5_000,
    updatedAt: 6_000,
    currentIndex: 1,
    completed: ["LOC-4444"],
    skipped: [],
    totalCount: 3,
    extra: {
      itemResolutions: [],
      summary: {
        adjusted: 0,
        locations: 1,
        relocated: 0,
        removed: 0,
        verified: 1,
      },
    },
    ...overrides,
  });

describe("listStoredSessionPasses", () => {
  it("lists a pass written under the current envelope, newest write first", () => {
    localStorage.setItem(KEY("LOC-AAAA"), v4({ updatedAt: 6_000 }));
    localStorage.setItem(KEY("LOC-BBBB"), v4({ updatedAt: 7_000 }));
    const passes = listStoredSessionPasses();
    expect(passes.map((p) => p.rootId)).toEqual(["LOC-BBBB", "LOC-AAAA"]);
    expect(passes[0]).toMatchObject({
      completedCount: 1,
      skippedCount: 0,
      totalCount: 3,
    });
  });

  it("skips malformed and unknown-version entries", () => {
    localStorage.setItem(KEY("LOC-FFFF"), "not json");
    localStorage.setItem(KEY("LOC-GGGG"), JSON.stringify({ version: 2 }));
    localStorage.setItem(KEY("LOC-HHHH"), JSON.stringify({ version: 3 }));
    expect(listStoredSessionPasses()).toEqual([]);
  });

  it("ignores keys outside the session prefix", () => {
    localStorage.setItem("cubby:photo-pass:house|false|", v4());
    expect(listStoredSessionPasses()).toEqual([]);
  });
});

describe("clearStoredSessionPass", () => {
  it("removes only the named pass", () => {
    localStorage.setItem(KEY("LOC-AAAA"), v4());
    localStorage.setItem(KEY("LOC-BBBB"), v4({ updatedAt: 7_000 }));
    clearStoredSessionPass("LOC-AAAA");
    expect(listStoredSessionPasses().map((p) => p.rootId)).toEqual([
      "LOC-BBBB",
    ]);
  });
});

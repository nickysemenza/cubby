import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStoredSessionPass,
  listStoredSessionPasses,
} from "./useSessionProgress";

const KEY = (rootId: string) => `cubby:audit-session:${rootId}`;

/**
 * The pass envelope moved from recount's own v3 shape onto the shared
 * `useQueuePass` one. A recount half-finished on a phone is stored locally and
 * nowhere else, so failing to read v3 does not degrade — it silently throws the
 * walk away. These lock the reader down.
 */
beforeEach(() => {
  localStorage.clear();
});

const v3 = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 3,
    startedAt: 1_000,
    updatedAt: 2_000,
    totalCount: 9,
    itemResolutions: [["INV-1111", { kind: "verify" }]],
    completedLocationIds: ["LOC-1111", "LOC-2222"],
    skippedLocationIds: ["LOC-3333"],
    currentIndex: 2,
    summary: {
      adjusted: 0,
      locations: 2,
      relocated: 0,
      removed: 0,
      verified: 1,
    },
    ...overrides,
  });

const v4 = (overrides: Record<string, unknown> = {}) =>
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
  it("still lists a pass written under v3", () => {
    localStorage.setItem(KEY("LOC-AAAA"), v3());
    const [pass] = listStoredSessionPasses();
    expect(pass).toMatchObject({
      rootId: "LOC-AAAA",
      startedAt: 1_000,
      updatedAt: 2_000,
      completedCount: 2,
      skippedCount: 1,
      totalCount: 9,
    });
  });

  it("lists a pass written under the current envelope", () => {
    localStorage.setItem(KEY("LOC-BBBB"), v4());
    const [pass] = listStoredSessionPasses();
    expect(pass).toMatchObject({
      rootId: "LOC-BBBB",
      completedCount: 1,
      skippedCount: 0,
      totalCount: 3,
    });
  });

  it("reads both versions side by side, newest write first", () => {
    localStorage.setItem(KEY("LOC-AAAA"), v3());
    localStorage.setItem(KEY("LOC-BBBB"), v4());
    expect(listStoredSessionPasses().map((p) => p.rootId)).toEqual([
      "LOC-BBBB",
      "LOC-AAAA",
    ]);
  });

  // v3 gained skippedLocationIds after it shipped, so entries written by an
  // older build of v3 legitimately lack it.
  it("treats a v3 entry with no skipped list as having none", () => {
    localStorage.setItem(
      KEY("LOC-CCCC"),
      v3({ skippedLocationIds: undefined }),
    );
    expect(listStoredSessionPasses()[0]?.skippedCount).toBe(0);
  });

  it("reports an absent v3 totalCount as null so callers fall back", () => {
    localStorage.setItem(KEY("LOC-DDDD"), v3({ totalCount: undefined }));
    expect(listStoredSessionPasses()[0]?.totalCount).toBeNull();
  });

  it("falls back to startedAt when v3 has no updatedAt", () => {
    localStorage.setItem(KEY("LOC-EEEE"), v3({ updatedAt: undefined }));
    expect(listStoredSessionPasses()[0]?.updatedAt).toBe(1_000);
  });

  it("skips malformed and unknown-version entries", () => {
    localStorage.setItem(KEY("LOC-FFFF"), "not json");
    localStorage.setItem(KEY("LOC-GGGG"), JSON.stringify({ version: 2 }));
    localStorage.setItem(KEY("LOC-HHHH"), v3({ completedLocationIds: null }));
    expect(listStoredSessionPasses()).toEqual([]);
  });

  it("ignores keys outside the session prefix", () => {
    localStorage.setItem("cubby:photo-pass:house|false|", v4());
    expect(listStoredSessionPasses()).toEqual([]);
  });
});

describe("clearStoredSessionPass", () => {
  it("removes only the named pass", () => {
    localStorage.setItem(KEY("LOC-AAAA"), v3());
    localStorage.setItem(KEY("LOC-BBBB"), v4());
    clearStoredSessionPass("LOC-AAAA");
    expect(listStoredSessionPasses().map((p) => p.rootId)).toEqual([
      "LOC-BBBB",
    ]);
  });
});

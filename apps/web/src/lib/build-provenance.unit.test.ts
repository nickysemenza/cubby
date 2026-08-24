import { describe, expect, it } from "vitest";
import { resolveBuildProvenance } from "./build-provenance";

const MAIN_COMMIT = "f8d6c22e0c1571fe1f3951b58324824451364b23";
const PR_HEAD_COMMIT = "ab6625cfad5a15d732332700bd8b73e1d9fd3b09";
const FALLBACK = {
  fallbackBranch: "HEAD",
  fallbackCommit: "c6b3715",
};

describe("resolveBuildProvenance", () => {
  it("uses a canonical main commit from production Worker metadata", () => {
    expect(
      resolveBuildProvenance({
        versionTag: `main-${MAIN_COMMIT}`,
        ...FALLBACK,
      }),
    ).toEqual({
      branch: "main",
      commit: "f8d6c22",
      commitUrl: `https://github.com/nickysemenza/cubby/commit/${MAIN_COMMIT}`,
    });
  });

  it("uses the real PR head commit from preview Worker metadata", () => {
    expect(
      resolveBuildProvenance({
        versionTag: `pr-897-${PR_HEAD_COMMIT}`,
        ...FALLBACK,
      }),
    ).toEqual({
      branch: "PR#897",
      commit: "ab6625c",
      commitUrl: `https://github.com/nickysemenza/cubby/commit/${PR_HEAD_COMMIT}`,
    });
  });

  it.each([undefined, "pr-897", "main-c6b3715", `main-${MAIN_COMMIT}x`])(
    "falls back to artifact provenance for version tag %s",
    (versionTag) => {
      expect(resolveBuildProvenance({ versionTag, ...FALLBACK })).toEqual({
        branch: "HEAD",
        commit: "c6b3715",
        commitUrl: "https://github.com/nickysemenza/cubby/commit/c6b3715",
      });
    },
  );
});

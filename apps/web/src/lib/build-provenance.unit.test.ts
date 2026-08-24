import { describe, expect, it } from "vitest";
import { resolveBuildProvenance } from "./build-provenance";

const MAIN_COMMIT = "f8d6c22e0c1571fe1f3951b58324824451364b23";
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

  it.each([undefined, "pr-896", "main-c6b3715", `main-${MAIN_COMMIT}x`])(
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

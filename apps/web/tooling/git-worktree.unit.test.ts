import { describe, expect, it, vi } from "vitest";
import { isGitWorktree } from "./git-worktree";

describe("isGitWorktree", () => {
  it("returns false for the primary checkout", () => {
    const resolvePath = vi.fn(() => "/repo/.git");

    expect(isGitWorktree("/repo/apps/web", resolvePath)).toBe(false);
    expect(resolvePath).toHaveBeenCalledWith("--git-dir", "/repo/apps/web");
    expect(resolvePath).toHaveBeenCalledWith(
      "--git-common-dir",
      "/repo/apps/web",
    );
  });

  it("returns true for a linked worktree", () => {
    const resolvePath = vi.fn((kind: "--git-dir" | "--git-common-dir") =>
      kind === "--git-dir" ? "/repo/.git/worktrees/feature" : "/repo/.git",
    );

    expect(isGitWorktree("/worktrees/feature/apps/web", resolvePath)).toBe(
      true,
    );
  });

  it("returns false outside a Git checkout", () => {
    const resolvePath = vi.fn(() => {
      throw new Error("not a git repository");
    });

    expect(isGitWorktree("/tmp", resolvePath)).toBe(false);
  });
});

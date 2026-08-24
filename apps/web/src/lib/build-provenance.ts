const GITHUB_REPOSITORY_URL = "https://github.com/nickysemenza/cubby";
const MAIN_VERSION_TAG = /^main-([0-9a-f]{40})$/;

export type BuildProvenance = {
  branch: string;
  commit: string;
  commitUrl: string;
};

type ResolveBuildProvenanceInput = {
  versionTag?: string;
  fallbackBranch: string;
  fallbackCommit: string;
};

/**
 * Prefer canonical deployment identity when production reuses a PR-built
 * artifact. Non-production versions retain the exact artifact provenance.
 */
export function resolveBuildProvenance({
  versionTag,
  fallbackBranch,
  fallbackCommit,
}: ResolveBuildProvenanceInput): BuildProvenance {
  const mainCommit = versionTag?.match(MAIN_VERSION_TAG)?.[1];
  const branch = mainCommit ? "main" : fallbackBranch;
  const commit = mainCommit ? mainCommit.slice(0, 7) : fallbackCommit;
  const linkCommit = mainCommit ?? fallbackCommit;

  return {
    branch,
    commit,
    commitUrl: `${GITHUB_REPOSITORY_URL}/commit/${linkCommit}`,
  };
}

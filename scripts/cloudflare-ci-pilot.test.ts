import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// These guards must fail before installing tools, touching .env, or starting a DB.
for (const scenario of [
  {
    mode: "deploy",
    branch: "codex/cloudflare-ci-pilot",
    ci: "1",
    error: /usage:/,
  },
  { mode: "full", branch: "main", ci: "1", error: /unexpected build branch/ },
  { mode: "probe", branch: "", ci: "1", error: /unexpected build branch/ },
  {
    mode: "full",
    branch: "codex/cloudflare-ci-pilot",
    ci: "",
    error: /Workers Builds environment required/,
  },
]) {
  test(`pilot rejects ${scenario.mode} branch=${scenario.branch} ci=${scenario.ci}`, () => {
    const result = spawnSync(
      "bash",
      ["scripts/cloudflare-ci-pilot.sh", scenario.mode],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          WORKERS_CI_BRANCH: scenario.branch,
          WORKERS_CI: scenario.ci,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, scenario.error);
    assert.equal(result.stdout, "");
  });
}

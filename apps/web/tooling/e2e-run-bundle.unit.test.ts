import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureE2ERunIdentity, writeE2ERunBundle } from "./e2e-run-bundle";

// Failure modes: a dirty run claims commit replayability; a commit or edit
// during the run is reported as the tested checkout; optional scenario/phase
// context is lost; checksum files no longer verify the summary.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});
it.each(["source-edit", "commit", "unchanged"])(
  "retains tested identity after %s during a run",
  (change) => {
    const root = mkdtempSync(path.join(tmpdir(), "cubby-run-identity-"));
    roots.push(root);
    const put = (file: string, content = "synthetic") => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    };
    const commit = () => {
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Synthetic",
          "-c",
          "user.email=synthetic@example.test",
          "commit",
          "--quiet",
          "-m",
          "Synthetic fixture",
        ],
        { cwd: root },
      );
    };
    put(".gitignore", "bundle/\n");
    put("apps/web/src/example.ts");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    commit();
    const started = captureE2ERunIdentity(root);
    if (change !== "unchanged")
      put("apps/web/src/example.ts", "new source during run");
    if (change === "commit") commit();
    const manifestPath = writeE2ERunBundle({
      repoRoot: root,
      outputDir: path.join(root, "bundle"),
      evidence: [],
      kind: "browser",
      status: "passed",
      command: ["synthetic"],
      started,
    });
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      status: change === "unchanged" ? "passed" : "changed-during-run",
      testStatus: "passed",
      source: started,
      changedDuringRun: change !== "unchanged",
      replayableFromCommit: change === "unchanged",
      build: null,
    });
  },
);
it("retains scenario and phase evidence for a failed, non-replayable dirty run", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-bundle-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.test",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "Synthetic fixture",
    ],
    { cwd: root },
  );
  writeFileSync(path.join(root, "dirty.ts"), "synthetic");
  const manifestPath = writeE2ERunBundle({
    repoRoot: root,
    outputDir: path.join(root, "bundle"),
    evidence: [],
    kind: "browser",
    status: "failed",
    command: ["pnpm", "test:e2e", "synthetic.spec.ts"],
    profile: "worker",
    scenario: "synthetic edit",
    fixture: "synthetic",
    fixtureVersion: 7,
    phase: "assertion",
    phases: [{ name: "build", durationMs: 42 }],
    build: {
      fingerprint: "synthetic",
      sourceFresh: true,
      matchesSource: false,
    },
    cases: [{ name: "synthetic edit", status: "failed" }],
  });
  expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
    replayableFromCommit: false,
    profile: "worker",
    scenario: "synthetic edit",
    fixture: "synthetic",
    fixtureVersion: 7,
    phase: "assertion",
    phases: [{ name: "build", durationMs: 42 }],
    build: { sourceFresh: true },
  });
  const digest = createHash("sha256")
    .update(readFileSync(manifestPath))
    .digest("hex");
  expect(readFileSync(path.join(root, "bundle/SHA256SUMS"), "utf8")).toContain(
    `${digest}  run-manifest.json`,
  );
});

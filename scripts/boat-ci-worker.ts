import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  pilotCredentialSchema,
  pilotJobs,
  pilotManifestSchema,
} from "./boat-ci.ts";
import { spawnToExit } from "./lib/run.ts";
import { pilotEvidenceStatus } from "./boat-ci-evidence.ts";

const base = path.resolve(import.meta.dirname, "..");
const local = process.argv[2] === "--local";
if (local && process.env.GITHUB_ACTIONS !== "true")
  throw new Error(
    "GitHub fallback requires a disposable GitHub Actions runner",
  );
const git = (...args: string[]) =>
  execFileSync("git", ["-C", base, ...args], { encoding: "utf8" }).trim();
const manifest = pilotManifestSchema.parse(
  local
    ? {
        revision: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        jobs: pilotJobs(
          ["e2e", "postgres", "aux", "build-worker"],
          Number(process.env.BOAT_E2E_SHARDS || 2),
          Number(process.env.BOAT_POSTGRES_SHARDS || 1),
          process.env.BOAT_AI_SMOKE === "true",
        ),
      }
    : JSON.parse(readFileSync(process.argv[2]!, "utf8")),
);
const resultsDir = local
  ? path.join(base, "artifacts/boat-ci/github")
  : "/home/user/boat-results";
mkdirSync(resultsDir, { recursive: true });
const results: {
  id: string;
  revision: string;
  tree: string;
  command: string;
  exitCode: number;
  durationMs: number;
  sourceClean: boolean;
  evidenceComplete: boolean;
  evidenceFailed: boolean;
}[] = [];
const save = () => {
  writeFileSync(
    path.join(resultsDir, "results.json.tmp"),
    JSON.stringify(results, null, 2),
  );
  renameSync(
    path.join(resultsDir, "results.json.tmp"),
    path.join(resultsDir, "results.json"),
  );
};
save();
if (
  git("rev-parse", "HEAD") !== manifest.revision ||
  git("rev-parse", "HEAD^{tree}") !== manifest.tree ||
  git("status", "--porcelain")
)
  throw new Error(
    "Worker checkout does not match the requested clean source revision/tree",
  );

const env = {
  ...process.env,
  CI: "true",
  NX_DAEMON: "false",
  NX_SKIP_REMOTE_CACHE: "true",
  NX_SKIP_NX_CACHE: "true",
  NX_SELF_HOSTED_REMOTE_CACHE_SERVER: "",
  NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: "",
  NODE_OPTIONS: "--max-old-space-size=4096",
  CARGO_BUILD_WARNINGS: "deny",
  PLAYWRIGHT_HTML_OPEN: "never",
  CUBBY_SOURCE_COMMIT: manifest.revision,
  CUBBY_SOURCE_BRANCH: "boat-pilot",
  CUBBY_CI_EXECUTOR: local ? "github" : "boat",
  CUBBY_CI_SNAPSHOT: local ? "" : process.env.CUBBY_CI_SNAPSHOT || "",
  CUBBY_BOAT_PILOT: "1",
  PLAYWRIGHT_BROWSERS_PATH: local
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : "/home/user/.local/share/ms-playwright",
  NX_CACHE_DIRECTORY: local
    ? process.env.NX_CACHE_DIRECTORY
    : "/home/user/.local/share/cubby-nx",
  BETTER_AUTH_SECRET: "boat-ci-synthetic-secret-not-for-production",
};
const credentials = manifest.jobs.some((job) => job.id === "ai-smoke")
  ? pilotCredentialSchema.parse(
      local
        ? Object.fromEntries(
            Object.keys(pilotCredentialSchema.shape).flatMap((key) =>
              process.env[key] ? [[key, process.env[key]]] : [],
            ),
          )
        : JSON.parse(readFileSync("/home/user/boat-runtime.json", "utf8")),
    )
  : {};
const run = async (command: string, args: string[], cwd = base) => {
  const code = await spawnToExit(command, args, { cwd, env, stdio: "inherit" });
  if (code !== 0) throw new Error(`${command} ${args[0]} exited ${code}`);
};

if (manifest.jobs.some((job) => job.db)) {
  const images = z
    .object({ postgres: z.string(), integresql: z.string() })
    .parse(
      JSON.parse(
        readFileSync(path.join(base, ".github/boat/images.json"), "utf8"),
      ),
    );
  await run("bash", [
    "-lc",
    "timeout 90 bash -c 'until docker info >/dev/null 2>&1; do sleep 1; done'",
  ]);
  await run("docker", ["network", "create", "cubby-ci"]);
  await run("docker", [
    "run",
    "--detach",
    "--name",
    "cubby-ci-postgres",
    "--network",
    "cubby-ci",
    "--network-alias",
    "postgres",
    "--publish",
    "127.0.0.1:5432:5432",
    "--publish",
    "127.0.0.1:55432:5432",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_DB=cubby",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    images.postgres,
    "-c",
    "jit=off",
    "-c",
    "fsync=off",
    "-c",
    "synchronous_commit=off",
    "-c",
    "full_page_writes=off",
  ]);
  await run("bash", [
    "-lc",
    "timeout 90 bash -c 'until docker exec cubby-ci-postgres pg_isready -h 127.0.0.1 -U postgres; do sleep 1; done'",
  ]);
  await run("docker", [
    "run",
    "--detach",
    "--name",
    "cubby-ci-integresql",
    "--network",
    "cubby-ci",
    "--publish",
    "127.0.0.1:5000:5000",
    "--env",
    "PGHOST=postgres",
    "--env",
    "PGUSER=postgres",
    "--env",
    "PGPASSWORD=password",
    images.integresql,
  ]);
  await run("bash", [
    "-lc",
    "timeout 90 bash -c 'until curl --silent --output /dev/null --max-time 2 http://127.0.0.1:5000/ >/dev/null; do sleep 1; done'",
  ]);
}

// The trial uses sequential grouped jobs within each machine. Every remote
// job still gets its own checkout, reports and worktree-wide harness lock.
for (const job of manifest.jobs) {
  const worktree = local ? base : `/home/user/cubby-jobs/${job.id}`;
  if (!local) {
    await run("git", [
      "-C",
      base,
      "worktree",
      "add",
      "--detach",
      worktree,
      manifest.revision,
    ]);
    await run("pnpm", [
      "--dir",
      worktree,
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
    ]);
  }
  const destination = path.join(resultsDir, job.id);
  mkdirSync(destination, { recursive: true });
  for (const item of [
    "apps/web/playwright-report",
    "apps/web/blob-report",
    "apps/web/test-results",
    "apps/web/.vitest-results.json",
    "apps/web/.e2e/runs/web",
    "artifacts/tester-army/web",
  ]) {
    rmSync(path.join(worktree, item), { recursive: true, force: true });
  }
  const started = performance.now();
  console.log(`[${job.id}] ${job.run}`);
  const code = await spawnToExit(
    "timeout",
    [
      "--signal=TERM",
      "--kill-after=10s",
      `${job.timeoutMinutes}m`,
      "bash",
      "-lc",
      job.run,
    ],
    {
      cwd: worktree,
      env: {
        ...env,
        ...(job.id === "ai-smoke" ? credentials : {}),
        TESTER_ARMY_CI_EVIDENCE: "1",
        TESTER_ARMY_REPLAY: "0",
        CUBBY_TEMPLATE_SERVICE_ID: `boat-${manifest.revision}-${job.id}`,
      },
      stdio: "inherit",
    },
  );
  // Persist a known failure before copying diagnostics; a later collection
  // error must never turn it into infrastructure fallback.
  const sourceClean =
    !execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim() &&
    execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim() === manifest.revision &&
    execFileSync("git", ["-C", worktree, "rev-parse", "HEAD^{tree}"], {
      encoding: "utf8",
    }).trim() === manifest.tree;
  const evidenceStatus = pilotEvidenceStatus(worktree, job, manifest.revision);
  results.push({
    id: job.id,
    revision: manifest.revision,
    tree: manifest.tree,
    command: job.run,
    exitCode: code,
    durationMs: Math.round(performance.now() - started),
    sourceClean,
    evidenceComplete: evidenceStatus === "passed",
    evidenceFailed: evidenceStatus === "failed",
  });
  save();
  console.log(`CUBBY_BOAT_RESULT ${JSON.stringify(results.at(-1))}`);
  for (const item of [
    "apps/web/playwright-report",
    "apps/web/blob-report",
    "apps/web/test-results",
    "apps/web/.vitest-results.json",
  ]) {
    const source = path.join(worktree, item);
    if (existsSync(source)) {
      const target = path.join(destination, item);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
  }
  if (job.id === "ai-smoke") {
    for (const directory of [
      "apps/web/.e2e/runs/web",
      "artifacts/tester-army/web",
    ]) {
      const source = path.join(worktree, directory);
      if (!existsSync(source)) continue;
      for (const entry of readdirSync(source, {
        recursive: true,
        encoding: "utf8",
      })) {
        if (
          !/(?:^|\/)(?:SHA256SUMS|gateway-usage\.json|run-manifest\.json|run-results\.json|report\.json|junit\.xml|trace\.md|screen-at-failure\.txt|agent-summary\.json)$|\/screenshots\/[^/]+\.png$|\/video\/[^/]+\.(?:mp4|webm)$/u.test(
            entry,
          )
        )
          continue;
        const target = path.join(destination, directory, entry);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.join(source, entry), target);
      }
    }
  }
}
if (
  local &&
  results.some(
    (result) =>
      result.exitCode !== 0 ||
      !result.sourceClean ||
      !result.evidenceComplete ||
      result.evidenceFailed,
  )
)
  process.exitCode = 1;

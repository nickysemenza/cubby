import { execFile } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { laneMatrix, type MatrixEntry } from "./ci-policy.ts";
import { spawnToExit } from "./lib/run.ts";
import { hasPilotEvidence } from "./boat-ci-evidence.ts";

export const pilotJobSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  run: z.string().min(1),
  db: z.boolean(),
  browser: z.boolean(),
  timeoutMinutes: z.number().int().positive(),
});
export type PilotJob = z.infer<typeof pilotJobSchema>;
export const pilotCredentialSchema = z.object({
  TESTER_ARMY_CF_API_TOKEN: z.string().min(1),
  TESTER_ARMY_CF_ACCOUNT_ID: z.string().min(1),
  TESTER_ARMY_MODEL: z.string().optional(),
  TESTER_ARMY_AGENT_MODEL: z.string().optional(),
  TESTER_ARMY_AGENT_EFFORT: z.string().optional(),
});
export const pilotManifestSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  tree: z.string().regex(/^[a-f0-9]{40}$/u),
  jobs: z.array(pilotJobSchema).min(1),
});

const evidenceSchema = z.object({
  id: z.string(),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  tree: z.string().regex(/^[a-f0-9]{40}$/u),
  command: z.string(),
  exitCode: z.number().int().min(0).max(255),
  durationMs: z.number().finite().nonnegative(),
  sourceClean: z.boolean(),
  evidenceComplete: z.boolean().optional(),
});

export function selectPilotExecutor(
  requested: string,
  credential: boolean,
  enabled: boolean,
) {
  return requested === "boat" && credential && enabled ? "boat" : "github";
}

export function pilotJobs(
  lanes: readonly string[],
  browserShards: number,
  postgresShards: number,
  aiSmoke = false,
): PilotJob[] {
  for (const count of [browserShards, postgresShards]) {
    if (!Number.isInteger(count) || count < 1 || count > 16)
      throw new Error("Pilot shard counts must be integers from 1 to 16");
  }
  const selected = lanes.filter((lane) =>
    ["aux", "build-worker", "postgres", "e2e"].includes(lane),
  );
  const entries: MatrixEntry[] = laneMatrix(selected).flatMap((entry) => [
    { ...entry, checks: undefined },
    ...(entry.checks ?? []).map((check) => ({ ...check, db: entry.db })),
  ]);
  const jobs: PilotJob[] = [];
  for (const entry of entries) {
    const lane = entry.lane!;
    if (lane === "e2e" && entry.browser !== "desktop-1") continue;
    const count =
      lane === "e2e" ? browserShards : lane === "postgres" ? postgresShards : 1;
    for (let shard = 1; shard <= count; shard++) {
      jobs.push({
        id: lane === "e2e" || lane === "postgres" ? `${lane}-${shard}` : lane,
        run:
          lane === "e2e"
            ? entry.run.replace(
                /CUBBY_E2E_SHARD=\d+\/\d+/u,
                `CUBBY_E2E_SHARD=${shard}/${count}`,
              )
            : lane === "postgres"
              ? `CUBBY_POSTGRES_SHARD=${shard}/${count} ${entry.run}`
              : entry.run,
        db: !!entry.db,
        browser: !!entry.browser,
        timeoutMinutes: entry.timeout ?? 20,
      });
    }
  }
  if (aiSmoke)
    jobs.push({
      id: "ai-smoke",
      run: "pnpm test:e2e:agent:preflight && pnpm test:e2e:agent:web -- --journey product-rename",
      db: true,
      browser: false,
      timeoutMinutes: 40,
    });
  return jobs;
}

export function assessBoatResults(
  jobs: readonly PilotJob[],
  reports: readonly object[],
  revision: string,
  tree: string,
) {
  const expected = new Map(jobs.map((job) => [job.id, job]));
  const valid = reports.flatMap((report) => {
    const parsed = evidenceSchema.safeParse(report);
    if (!parsed.success) return [];
    const evidence = parsed.data;
    return evidence.revision === revision &&
      evidence.tree === tree &&
      expected.get(evidence.id)?.run === evidence.command
      ? [evidence]
      : [];
  });
  // A failure already observed on the requested source is sticky, even when
  // another machine's output is missing after a provider failure.
  if (valid.some((report) => report.exitCode !== 0 || !report.sourceClean))
    return "failed";
  const ids = new Set(valid.map((report) => report.id));
  return valid.length === reports.length &&
    valid.length === jobs.length &&
    ids.size === jobs.length &&
    valid.every((report) => report.evidenceComplete === true)
    ? "passed"
    : "fallback";
}

const capture = promisify(execFile);
const defaultRoot = path.resolve(import.meta.dirname, "..");

async function cli(args: string[], timeout = 90_000) {
  const result = await capture("boat", [...args, "--no-update"], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

function readyId(output: string): string {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (
      event.event === "ready" &&
      typeof event.id === "string" &&
      /^[\w-]+$/u.test(event.id)
    )
      return event.id;
  }
  throw new Error("Boat creation returned no ready sandbox ID");
}

export async function coordinatePilot(root: string) {
  const revision = (
    await capture("git", ["-C", root, "rev-parse", "HEAD"])
  ).stdout.trim();
  const tree = (
    await capture("git", ["-C", root, "rev-parse", "HEAD^{tree}"])
  ).stdout.trim();
  if (
    (await capture("git", ["-C", root, "status", "--porcelain"])).stdout.trim()
  )
    throw new Error("Pilot requires a committed, clean source checkout");
  const jobs = pilotJobs(
    ["e2e", "postgres", "aux", "build-worker"],
    Number(process.env.BOAT_E2E_SHARDS || 2),
    Number(process.env.BOAT_POSTGRES_SHARDS || 1),
    process.env.BOAT_AI_SMOKE === "true",
  );
  const output = path.join(root, "artifacts/boat-ci");
  mkdirSync(output, { recursive: true });
  const snapshot = process.env.BOAT_CI_SNAPSHOT || "";
  if (snapshot && !/^[a-zA-Z0-9_-]{1,128}$/u.test(snapshot))
    throw new Error("Invalid Boat snapshot name");
  const enabled = process.env.BOAT_CI_ENABLED !== "false";
  let outcome = "fallback";
  const reports: object[] = [];
  const observedFailures: object[] = [];
  const privateDir = mkdtempSync(
    path.join(tmpdir(), "cubby-boat-credentials-"),
  );
  let cancelled = false;
  const abort = new AbortController();
  const cancel = () => {
    cancelled = true;
    abort.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (
      selectPilotExecutor(
        process.env.BOAT_EXECUTOR || "github",
        !!process.env.BOAT_API_KEY || process.env.GITHUB_ACTIONS !== "true",
        enabled,
      ) === "boat" &&
      snapshot
    ) {
      const limitsOutput = await cli(["limits", "--json"]);
      const limits = JSON.parse(
        limitsOutput.split("\n").find((line) => line.trim()) || "{}",
      );
      const available = limits.limits ?? limits;
      if (available.canStart !== true || !(available.creditBalanceSeconds > 0))
        throw new Error(
          `Boat cannot start: ${available.startBlockedReason ?? available.blockedReason ?? "balance unavailable"}`,
        );
      const count = Math.min(
        Number(process.env.BOAT_MACHINES || 2),
        jobs.length,
      );
      if (!Number.isInteger(count) || count < 1 || count > 8)
        throw new Error("BOAT_MACHINES must be 1–8");
      const groups = Array.from({ length: count }, (_, index) =>
        jobs.filter((_, job) => job % count === index),
      );
      await Promise.allSettled(
        groups.map(async (group, index) => {
          let id: string | undefined;
          try {
            if (cancelled) return;
            id = readyId(
              await cli([
                "new",
                "--no-env",
                "--no-snapshots",
                "--fail-fast",
                "--ttl",
                "3600",
                "--type",
                process.env.BOAT_MACHINE_TYPE || "default",
                "--from",
                snapshot,
                "--json",
              ]),
            );
            if (cancelled) return;
            const manifest = path.join(output, `manifest-${index}.json`);
            writeFileSync(
              manifest,
              JSON.stringify({ revision, tree, jobs: group }),
            );
            await cli(["scp", manifest, `${id}:/home/user/boat-manifest.json`]);
            if (group.some((job) => job.id === "ai-smoke")) {
              const credentials = pilotCredentialSchema.parse(
                Object.fromEntries(
                  Object.keys(pilotCredentialSchema.shape).flatMap((key) =>
                    process.env[key] ? [[key, process.env[key]]] : [],
                  ),
                ),
              );
              const file = path.join(privateDir, `runtime-${index}.json`);
              writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
              await cli(["scp", file, `${id}:/home/user/boat-runtime.json`]);
            }
            // The worker is fetched from the immutable public revision, not from
            // mutable snapshot source. Fetching a merge SHA retains Git identity.
            const command = `git -C /home/user/cubby-ci fetch --depth=1 origin ${revision} && git -C /home/user/cubby-ci checkout --force --detach ${revision} && CUBBY_CI_SNAPSHOT=${snapshot} node /home/user/cubby-ci/scripts/boat-ci-worker.ts /home/user/boat-manifest.json`;
            let frames = "";
            let stdout = "";
            await spawnToExit(
              "boat",
              [
                "exec",
                id,
                "--timeout",
                "0",
                "--stream",
                "--json",
                "--no-update",
                "--",
                "bash",
                "-lc",
                command,
              ],
              {
                cwd: root,
                stdio: ["ignore", "pipe", "inherit"],
                signal: abort.signal,
                onSpawn: (child) =>
                  child.stdout?.on("data", (chunk: Buffer) => {
                    process.stdout.write(chunk);
                    frames += chunk.toString();
                    let newline: number;
                    while ((newline = frames.indexOf("\n")) >= 0) {
                      const line = frames.slice(0, newline);
                      frames = frames.slice(newline + 1);
                      try {
                        const frame = JSON.parse(line);
                        if (
                          frame.type !== "stdout" ||
                          typeof frame.data !== "string"
                        )
                          continue;
                        stdout += frame.data;
                        let end: number;
                        while ((end = stdout.indexOf("\n")) >= 0) {
                          const record = stdout.slice(0, end);
                          stdout = stdout.slice(end + 1);
                          if (!record.startsWith("CUBBY_BOAT_RESULT "))
                            continue;
                          const evidence = JSON.parse(
                            record.slice("CUBBY_BOAT_RESULT ".length),
                          );
                          if (
                            assessBoatResults(
                              group,
                              [evidence],
                              revision,
                              tree,
                            ) === "failed"
                          )
                            observedFailures.push(evidence);
                        }
                      } catch {
                        /* Non-protocol logs cannot establish a result. */
                      }
                    }
                  }),
              },
            );
          } catch (error) {
            console.error(
              `[Boat machine ${index}]`,
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            if (id) {
              const destination = path.join(output, `machine-${index}`);
              mkdirSync(destination, { recursive: true });
              try {
                await cli([
                  "scp",
                  "-r",
                  `${id}:/home/user/boat-results/.`,
                  destination,
                ]);
                const evidence = JSON.parse(
                  readFileSync(path.join(destination, "results.json"), "utf8"),
                );
                if (Array.isArray(evidence))
                  reports.push(
                    ...evidence.map((record) => {
                      const job = group.find((task) => task.id === record.id);
                      return {
                        ...record,
                        evidenceComplete:
                          !!job &&
                          hasPilotEvidence(
                            path.join(destination, record.id),
                            job,
                            revision,
                          ),
                      };
                    }),
                  );
              } catch (error) {
                console.error(
                  `[Boat evidence ${index}]`,
                  error instanceof Error ? error.message : String(error),
                );
              }
              try {
                await cli(["delete", id, "--yes", "--json"]);
              } catch (error) {
                console.error(
                  `[Boat cleanup ${index}; auto-stop remains active]`,
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
          }
        }),
      );
      outcome = observedFailures.length
        ? "failed"
        : assessBoatResults(jobs, reports, revision, tree);
    }
  } catch (error) {
    console.error(
      "[Boat preflight]",
      error instanceof Error ? error.message : String(error),
    );
    outcome = observedFailures.length
      ? "failed"
      : assessBoatResults(jobs, reports, revision, tree);
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  if (cancelled) outcome = "cancelled";
  writeFileSync(
    path.join(output, "summary.json"),
    JSON.stringify(
      { revision, tree, outcome, jobs, reports, observedFailures },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${outcome}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nBoat pilot: **${outcome}**, source \`${revision}\`, ${reports.length}/${jobs.length} task records. See uploaded artifacts and per-task logs.\n`,
    );
  if (outcome === "failed") process.exitCode = 1;
  if (outcome === "cancelled") process.exitCode = 130;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await coordinatePilot(defaultRoot);

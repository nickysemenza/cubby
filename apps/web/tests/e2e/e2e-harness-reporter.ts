import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { z } from "zod";

import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunBundleInput,
  type E2ERunIdentity,
} from "../../tooling/e2e-run-bundle";
import { FAKER_SEED_ANNOTATION } from "../../tooling/factories/faker";
import { assertTestRunContract } from "../../tooling/test-run-contract";
import {
  gitRevision,
  webBuildSourceFingerprint,
} from "../../tooling/web-build-provenance";
import {
  WORKERD_EXPLORER_ANNOTATION,
  WORKERD_LOGS_ATTACHMENT,
} from "../../tooling/e2e-workerd-logs";

import { discoverHmrSession } from "./hmr-session";
import {
  NAVIGATION_ANNOTATION,
  NAVIGATION_PHASES_ANNOTATION,
} from "./navigation-timing";

/** `lane: "hmr"` (playwright.dev.config.ts) tests the live dev session, not dist. */
type ReporterOptions = { lane?: "built" | "hmr" };

/** Vite serves current source, so freshness is the source fingerprint holding still. */
function hmrIdentity(repoRoot: string) {
  return {
    ...gitRevision(repoRoot),
    fingerprint: webBuildSourceFingerprint(repoRoot),
  };
}

class E2EHarnessReporter implements Reporter {
  private outcomes: Array<{ name: string; state: string }> = [];
  private bundleCases: Array<{
    name: string;
    status: string;
    durationMs: number;
    explorerUrl?: string;
  }> = [];
  private workerdLogs: Array<{ name: string; body: Buffer }> = [];
  private runStatus = "interrupted";
  private navigation: Array<{ name: string; ms: number; count: number }> = [];
  private durations: Array<{
    name: string;
    totalMs: number;
    navigationMs: number;
  }> = [];
  private testMs = 0;
  private phases: number[][] = [];
  private started?: E2ERunIdentity;
  private hmrStarted?: ReturnType<typeof hmrIdentity> & {
    session: ReturnType<typeof discoverHmrSession>["session"];
  };

  constructor(private readonly options: ReporterOptions = {}) {}

  onBegin(): void {
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    if (this.options.lane === "hmr")
      this.hmrStarted = {
        ...hmrIdentity(repoRoot),
        session: discoverHmrSession().session,
      };
    else this.started = captureE2ERunIdentity(repoRoot);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.retry === 0) {
      const name = test.titlePath().join(" > ");
      this.outcomes.push({
        name,
        state: result.status,
      });
      const explorerUrl = result.annotations.find(
        (annotation) => annotation.type === WORKERD_EXPLORER_ANNOTATION,
      )?.description;
      this.bundleCases.push({
        name,
        status: result.status,
        durationMs: result.duration,
        ...(explorerUrl && { explorerUrl }),
      });
      const logs = result.attachments.find(
        (attachment) =>
          attachment.name === WORKERD_LOGS_ATTACHMENT && attachment.body,
      )?.body;
      if (logs) this.workerdLogs.push({ name, body: logs });
    }
    if (result.status === "failed" || result.status === "timedOut") {
      const seed = result.annotations.find(
        (annotation) => annotation.type === FAKER_SEED_ANNOTATION,
      );
      if (seed)
        console.error(
          `[faker] ${test.titlePath().join(" > ")} used seed ${seed.description} (fakerFromSeed(${seed.description}) replays it)`,
        );
    }
    const loads = result.annotations
      .filter((annotation) => annotation.type === NAVIGATION_ANNOTATION)
      .map((annotation) => Number(annotation.description));
    const navigationMs = loads.reduce((sum, ms) => sum + ms, 0);
    if (result.retry === 0)
      this.durations.push({
        name: `${test.parent.project()?.name ?? ""} › ${test.title}`,
        totalMs: result.duration,
        navigationMs,
      });
    this.testMs += result.duration;
    for (const annotation of result.annotations) {
      if (annotation.type !== NAVIGATION_PHASES_ANNOTATION) continue;
      const values = (annotation.description ?? "").split(",").map(Number);
      if (values.length === 4 && values.every(Number.isFinite))
        this.phases.push(values);
    }
    if (loads.length > 0) {
      this.navigation.push({
        name: `${test.parent.project()?.name ?? ""} › ${test.title}`,
        ms: navigationMs,
        count: loads.length,
      });
    }
  }

  onEnd(result: FullResult): void {
    this.runStatus = result.status;
    this.printNavigationSummary();
    this.printDurationSummary();
    assertTestRunContract(this.outcomes, {
      allowEmpty: ["--last-failed", "--list"].some((argument) =>
        process.argv.includes(argument),
      ),
    });
  }

  onExit(): Promise<void> {
    const webRoot = path.resolve(import.meta.dirname, "../..");
    const repoRoot = path.resolve(webRoot, "../..");
    const hmr = this.options.lane === "hmr";
    const reportDir = path.join(
      webRoot,
      hmr ? "playwright-report/hmr" : "playwright-report",
    );
    mkdirSync(reportDir, { recursive: true });
    const resultsPath = path.join(reportDir, "run-results.json");
    writeFileSync(
      resultsPath,
      `${JSON.stringify({ status: this.runStatus, cases: this.bundleCases }, null, 2)}\n`,
    );
    // Failed tests only; messages were credential-scrubbed in the test worker.
    const logsDir = path.join(reportDir, "workerd-logs");
    rmSync(logsDir, { recursive: true, force: true });
    this.workerdLogs.forEach(({ name, body }, index) => {
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(
        path.join(logsDir, `failure-${index + 1}.json`),
        `${JSON.stringify({ test: name, logs: JSON.parse(body.toString("utf8")) }, null, 2)}
`,
      );
    });
    const arguments_ = process.argv
      .slice(2)
      .filter(
        (argument) => argument !== "test" && !argument.startsWith("--config"),
      );
    const manifest = writeE2ERunBundle({
      repoRoot,
      outputDir: reportDir,
      evidence: [resultsPath, logsDir],
      kind: "browser",
      ...(hmr
        ? this.hmrBundle(repoRoot)
        : { status: this.runStatus, started: this.started }),
      command: [
        "pnpm",
        "--dir",
        "apps/web",
        hmr ? "test:e2e:hmr" : "test:e2e",
        ...arguments_,
      ],
      cases: this.bundleCases,
      profile: hmr ? "hmr-session" : "built-worker",
      scenario: this.bundleCases.map((testCase) => testCase.name).join("; "),
      fixture: hmr
        ? "run-owned kernel fixtures in the session database"
        : "isolated E2E scenario builders",
      fixtureVersion: 1,
      phases: [{ name: "test", durationMs: this.testMs }],
      runtime: {
        playwright: z
          .object({ version: z.string() })
          .parse(
            JSON.parse(
              readFileSync(
                path.join(
                  webRoot,
                  "node_modules/@playwright/test/package.json",
                ),
                "utf8",
              ),
            ),
          ).version,
      },
    });
    console.log(`[E2E artifact] ${manifest}`);
    return Promise.resolve();
  }

  /** The tested runtime is the session's live source, not a built Worker. */
  private hmrBundle(
    repoRoot: string,
  ): Pick<E2ERunBundleInput, "status" | "build"> {
    const started = this.hmrStarted;
    if (!started) throw new Error("HMR lane ended without a start identity");
    const ended = hmrIdentity(repoRoot);
    const changed =
      started.commit !== ended.commit ||
      started.dirty !== ended.dirty ||
      started.fingerprint !== ended.fingerprint;
    return {
      status: changed ? "changed-during-run" : this.runStatus,
      build: {
        fingerprint: started.fingerprint,
        sourceFresh: !changed,
        matchesSource: !changed && !started.dirty,
        details: {
          reason: changed ? "changed-during-run" : "hmr-session",
          sourceCommit: started.commit,
          sourceDirty: started.dirty,
          devId: started.session.id,
          devProfile: started.session.profile,
          sessionStartedAt: started.session.startedAt,
        },
      },
    };
  }

  private printDurationSummary(): void {
    if (this.durations.length === 0) return;
    console.log(
      [
        "[e2e duration] longest test time outside timed page loads (total, page load):",
        ...[...this.durations]
          .sort(
            (a, b) => b.totalMs - b.navigationMs - (a.totalMs - a.navigationMs),
          )
          .slice(0, 10)
          .map(
            ({ name, totalMs, navigationMs }) =>
              `  ${((totalMs - navigationMs) / 1000).toFixed(1)}s outside, ${(totalMs / 1000).toFixed(1)}s total, ${(navigationMs / 1000).toFixed(1)}s page load  ${name}`,
          ),
      ].join("\n"),
    );
  }

  /** Page loads (goto/reload + hydration through the shared helpers) as a
   * share of test time, and the tests that spend the most on them. */
  private printNavigationSummary(): void {
    if (this.navigation.length === 0 || this.testMs === 0) return;
    const totalMs = this.navigation.reduce((sum, row) => sum + row.ms, 0);
    const loads = this.navigation.reduce((sum, row) => sum + row.count, 0);
    const lines = [
      `[e2e navigation] ${loads} page loads, ${(totalMs / 1000).toFixed(1)}s of ${(this.testMs / 1000).toFixed(1)}s test time (${Math.round((totalMs / this.testMs) * 100)}%)`,
      ...[...this.navigation]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 10)
        .map(
          (row) =>
            `  ${(row.ms / 1000).toFixed(1)}s over ${row.count} loads  ${row.name}`,
        ),
    ];
    if (this.phases.length > 0) {
      const median = (index: number) => {
        const sorted = this.phases
          .map((row) => row[index] ?? 0)
          .sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
      };
      lines.push(
        `  median ms from navigation start: first byte ${median(0)}, HTML done ${median(1)}, DOMContentLoaded ${median(2)}, hydrated seen ${median(3)} (n=${this.phases.length})`,
      );
    }
    console.log(lines.join("\n"));
  }
}

export default E2EHarnessReporter;

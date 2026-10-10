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

/** `lane: "hmr"` (playwright.dev.config.ts) tests the live dev session, not dist. */
type ReporterOptions = { lane?: "built" | "hmr" };

/** Vite serves current source, so freshness is the source fingerprint holding still. */
function hmrIdentity(repoRoot: string) {
  return {
    ...gitRevision(repoRoot),
    fingerprint: webBuildSourceFingerprint(repoRoot),
  };
}

/**
 * Writes the sanitized E2E run bundle (with failed tests' workerd logs) and
 * enforces the test-run contract. Console and HTML output come from
 * Playwright's built-in reporters, slow files from `reportSlowTests`.
 */
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
  private testMs = 0;
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
    this.testMs += result.duration;
  }

  onEnd(result: FullResult): void {
    this.runStatus = result.status;
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
}

export default E2EHarnessReporter;

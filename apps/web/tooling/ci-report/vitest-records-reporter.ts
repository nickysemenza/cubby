import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import type { TestRecord } from "./records.ts";

const repoRoot = join(import.meta.dirname, "../../../..");

/**
 * Writes one normalized record per test for the CI summary. Runs during
 * `vitest --merge-reports`, which replays every shard's blob: the JSON
 * reporter has no retry or flaky fields, and the summary needs both.
 */
export default class VitestRecordsReporter implements Reporter {
  private readonly outputFile =
    process.env.CUBBY_VITEST_RECORDS ?? ".vitest/records.json";

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const records: TestRecord[] = [];
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        const result = testCase.result();
        const diagnostic = testCase.diagnostic();
        records.push({
          runner: "vitest",
          project: testCase.project.name,
          // Repository-relative: tooling and package projects use the repo root.
          file: relative(repoRoot, testModule.moduleId),
          name: testCase.fullName,
          state:
            result.state === "failed"
              ? "failed"
              : result.state === "passed"
                ? "passed"
                : "skipped",
          durationMs: diagnostic?.duration ?? 0,
          flaky: diagnostic?.flaky ?? false,
          error: result.errors?.[0]?.message,
        });
      }
    }
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, JSON.stringify(records));
  }
}

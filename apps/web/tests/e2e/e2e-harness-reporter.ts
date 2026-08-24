import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import type { TestHarness } from "wrangler";

class E2EHarnessReporter implements Reporter {
  private sawRetry = false;
  private readonly durations = new Map<string, number>();

  onTestEnd(test: TestCase, result: TestResult): void {
    this.sawRetry ||= result.retry > 0;
    const file = relative(process.cwd(), test.location.file);
    this.durations.set(file, (this.durations.get(file) ?? 0) + result.duration);
  }

  onEnd(result: FullResult): void {
    if (process.env.CI) {
      const directory = join(process.cwd(), ".playwright-timing");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, `shard-${process.env.MATRIX_SHARD ?? "local"}.json`),
        `${JSON.stringify(Object.fromEntries(this.durations), null, 2)}\n`,
      );
    }
    if (result.status === "passed" && !this.sawRetry) {
      return;
    }

    const harness = (globalThis as Record<string, unknown>).__E2E_HARNESS__ as
      | TestHarness
      | undefined;
    harness?.debug();
  }
}

export default E2EHarnessReporter;

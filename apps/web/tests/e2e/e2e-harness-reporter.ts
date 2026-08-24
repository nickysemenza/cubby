import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import type { TestHarness } from "wrangler";

class E2EHarnessReporter implements Reporter {
  private sawRetry = false;

  onTestEnd(_test: TestCase, result: TestResult): void {
    this.sawRetry ||= result.retry > 0;
  }

  onEnd(result: FullResult): void {
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

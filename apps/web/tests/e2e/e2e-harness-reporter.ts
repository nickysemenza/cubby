import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import "./e2e-runtime-state";

class E2EHarnessReporter implements Reporter {
  private sawRetry = false;

  onTestEnd(_test: TestCase, result: TestResult): void {
    this.sawRetry ||= result.retry > 0;
  }

  onEnd(result: FullResult): void {
    if (result.status === "passed" && !this.sawRetry) {
      return;
    }

    globalThis.__E2E_HARNESS__?.debug();
  }
}

export default E2EHarnessReporter;

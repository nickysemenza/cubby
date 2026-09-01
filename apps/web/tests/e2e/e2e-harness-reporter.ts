import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import "./e2e-runtime-state";

class E2EHarnessReporter implements Reporter {
  private sawRetry = false;
  private completed = 0;

  onTestEnd(_test: TestCase, result: TestResult): void {
    this.sawRetry ||= result.retry > 0;
    if (result.retry === 0) this.completed += 1;
  }

  onEnd(result: FullResult): void {
    const configured = process.env.CUBBY_EXPECT_E2E_TESTS;
    if (configured) {
      const expected = Number(configured);
      if (!Number.isSafeInteger(expected) || this.completed !== expected) {
        throw new Error(
          `Authoritative Playwright manifest expected ${configured} tests, received ${this.completed}`,
        );
      }
    }
    if (result.status === "passed" && !this.sawRetry) {
      return;
    }

    globalThis.__E2E_HARNESS__?.debug();
  }
}

export default E2EHarnessReporter;

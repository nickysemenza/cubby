import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import { assertTestRunContract } from "../../tooling/test-run-contract";
import "./e2e-runtime-state";

class E2EHarnessReporter implements Reporter {
  private sawRetry = false;
  private outcomes: Array<{ name: string; state: string }> = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    this.sawRetry ||= result.retry > 0;
    if (result.retry === 0) {
      this.outcomes.push({
        name: test.titlePath().join(" > "),
        state: result.status,
      });
    }
  }

  onEnd(result: FullResult): void {
    const requiresDebug = result.status !== "passed" || this.sawRetry;
    try {
      assertTestRunContract(this.outcomes);
    } catch (error) {
      if (!requiresDebug) globalThis.__E2E_HARNESS__?.debug();
      throw error;
    } finally {
      if (requiresDebug) globalThis.__E2E_HARNESS__?.debug();
    }
  }
}

export default E2EHarnessReporter;

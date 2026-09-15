import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { assertTestRunContract } from "../../tooling/test-run-contract";

class E2EHarnessReporter implements Reporter {
  private outcomes: Array<{ name: string; state: string }> = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.retry === 0) {
      this.outcomes.push({
        name: test.titlePath().join(" > "),
        state: result.status,
      });
    }
  }

  onEnd(): void {
    assertTestRunContract(this.outcomes, {
      allowEmpty: ["--last-failed", "--list"].some((argument) =>
        process.argv.includes(argument),
      ),
    });
  }
}

export default E2EHarnessReporter;

import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { assertTestRunContract } from "../../tooling/test-run-contract";

import { NAVIGATION_ANNOTATION } from "./navigation-timing";

class E2EHarnessReporter implements Reporter {
  private outcomes: Array<{ name: string; state: string }> = [];
  private navigation: Array<{ name: string; ms: number; count: number }> = [];
  private testMs = 0;

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.retry === 0) {
      this.outcomes.push({
        name: test.titlePath().join(" > "),
        state: result.status,
      });
    }
    const loads = result.annotations
      .filter((annotation) => annotation.type === NAVIGATION_ANNOTATION)
      .map((annotation) => Number(annotation.description));
    this.testMs += result.duration;
    if (loads.length > 0) {
      this.navigation.push({
        name: `${test.parent.project()?.name ?? ""} › ${test.title}`,
        ms: loads.reduce((sum, ms) => sum + ms, 0),
        count: loads.length,
      });
    }
  }

  onEnd(): void {
    this.printNavigationSummary();
    assertTestRunContract(this.outcomes, {
      allowEmpty: ["--last-failed", "--list"].some((argument) =>
        process.argv.includes(argument),
      ),
    });
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
    console.log(lines.join("\n"));
  }
}

export default E2EHarnessReporter;

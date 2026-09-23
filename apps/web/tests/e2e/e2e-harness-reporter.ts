import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { assertTestRunContract } from "../../tooling/test-run-contract";

import {
  NAVIGATION_ANNOTATION,
  NAVIGATION_PHASES_ANNOTATION,
} from "./navigation-timing";

class E2EHarnessReporter implements Reporter {
  private outcomes: Array<{ name: string; state: string }> = [];
  private navigation: Array<{ name: string; ms: number; count: number }> = [];
  private durations: Array<{
    name: string;
    totalMs: number;
    navigationMs: number;
  }> = [];
  private testMs = 0;
  private phases: number[][] = [];

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

  onEnd(): void {
    this.printNavigationSummary();
    this.printDurationSummary();
    assertTestRunContract(this.outcomes, {
      allowEmpty: ["--last-failed", "--list"].some((argument) =>
        process.argv.includes(argument),
      ),
    });
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

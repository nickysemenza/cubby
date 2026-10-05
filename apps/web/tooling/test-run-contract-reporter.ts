import type { Reporter, TestModule, Vitest } from "vitest/node";

import { assertTestRunContract } from "./test-run-contract";

export default class TestRunContractReporter implements Reporter {
  private namePattern: RegExp | undefined;

  onInit(vitest: Vitest): void {
    this.namePattern = vitest.config.testNamePattern;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const namePattern = this.namePattern;
    assertTestRunContract(
      testModules.flatMap((testModule) =>
        [...testModule.children.allTests()].map((testCase) => {
          const state = testCase.result().state;
          return {
            name: `${testModule.relativeModuleId} > ${testCase.fullName}`,
            state,
            // Vitest skips `-t` misses by matching this same full name, so a
            // skipped test the pattern still matches is a real `.skip`.
            deselected:
              state === "skipped" &&
              namePattern !== undefined &&
              !namePattern.test(testCase.fullName),
          };
        }),
      ),
      // The reporter runs in the main vitest process, so argv is the CLI's.
      { allowEmpty: process.argv.includes("--changed") },
    );
  }
}

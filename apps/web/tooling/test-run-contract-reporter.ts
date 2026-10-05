import type { Reporter, TestModule, Vitest } from "vitest/node";

import { assertTestRunContract } from "./test-run-contract";

export default class TestRunContractReporter implements Reporter {
  private rootNamePattern: RegExp | undefined;

  onInit(vitest: Vitest): void {
    this.rootNamePattern = vitest.config.testNamePattern;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    assertTestRunContract(
      testModules.flatMap((testModule) =>
        [...testModule.children.allTests()].map((testCase) => {
          const state = testCase.result().state;
          const namePattern =
            testCase.project.config.testNamePattern ?? this.rootNamePattern;
          return {
            name: `${testModule.relativeModuleId} > ${testCase.fullName}`,
            state,
            // Vitest skips `-t` misses with this same `fullName.match`, so a
            // skipped test the pattern still matches is a real `.skip`.
            // (`match`, not `test`: a /g pattern's lastIndex must not leak.)
            deselected:
              state === "skipped" &&
              namePattern !== undefined &&
              !testCase.fullName.match(namePattern),
          };
        }),
      ),
      // The reporter runs in the main vitest process, so argv is the CLI's.
      { allowEmpty: process.argv.includes("--changed") },
    );
  }
}

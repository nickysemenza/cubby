import type { Reporter, TestModule } from "vitest/node";

import { assertTestRunContract } from "./test-run-contract";

export default class TestRunContractReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    assertTestRunContract(
      testModules.flatMap((testModule) =>
        [...testModule.children.allTests()].map((testCase) => ({
          name: `${testModule.relativeModuleId} > ${testCase.fullName}`,
          state: testCase.result().state,
        })),
      ),
    );
  }
}

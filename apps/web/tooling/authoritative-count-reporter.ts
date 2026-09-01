import type { Reporter, TestModule } from "vitest/node";

export default class AuthoritativeCountReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const configured = process.env.CUBBY_EXPECT_POSTGRES_TESTS;
    if (!configured) return;

    const expected = Number(configured);
    const actual = testModules.reduce(
      (count, testModule) => count + [...testModule.children.allTests()].length,
      0,
    );
    if (!Number.isSafeInteger(expected) || actual !== expected) {
      throw new Error(
        `Authoritative PostgreSQL manifest expected ${configured} tests, received ${actual}`,
      );
    }
  }
}

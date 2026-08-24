import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

/** Writes per-file timing evidence for CI shard planning. */
export default class TimingReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    if (!process.env.CI) return;
    const project = testModules[0]?.project.name ?? "unknown";
    const label = (process.env.VITEST_BLOB_LABEL ?? project).replace(
      /[^a-z0-9._-]/giu,
      "-",
    );
    const timings = Object.fromEntries(
      testModules.map((module) => {
        const diagnostic = module.diagnostic();
        return [
          module.relativeModuleId,
          {
            collect: diagnostic.collectDuration,
            environment: diagnostic.environmentSetupDuration,
            prepare: diagnostic.prepareDuration,
            setup: diagnostic.setupDuration,
            tests: diagnostic.duration,
            total:
              diagnostic.collectDuration +
              diagnostic.environmentSetupDuration +
              diagnostic.prepareDuration +
              diagnostic.setupDuration +
              diagnostic.duration,
          },
        ];
      }),
    );
    const directory = join(process.cwd(), ".vitest", "timing");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${label}.json`),
      `${JSON.stringify({ project, timings }, null, 2)}\n`,
    );
  }
}

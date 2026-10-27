import { z } from "zod";

/** One test outcome in the combined CI summary, from either runner. */
export const testRecordSchema = z.object({
  runner: z.enum(["vitest", "playwright", "tester-army"]),
  project: z.string(),
  /** Repository-relative path. */
  file: z.string(),
  name: z.string(),
  state: z.enum(["passed", "failed", "skipped"]),
  /** The final attempt's duration. */
  durationMs: z.number(),
  /** Failed at least once, then passed on retry. */
  flaky: z.boolean(),
  error: z.string().optional(),
});
export type TestRecord = z.infer<typeof testRecordSchema>;

const playwrightSpecSchema = z.object({
  title: z.string(),
  file: z.string(),
  tests: z.array(
    z.object({
      projectName: z.string(),
      status: z.enum(["expected", "unexpected", "flaky", "skipped"]),
      results: z.array(
        z.object({
          duration: z.number(),
          error: z.object({ message: z.string().optional() }).optional(),
        }),
      ),
    }),
  ),
});
type PlaywrightSuite = {
  title: string;
  specs?: z.infer<typeof playwrightSpecSchema>[];
  suites?: PlaywrightSuite[];
};
const playwrightSuiteSchema: z.ZodType<PlaywrightSuite> = z.lazy(() =>
  z.object({
    title: z.string(),
    specs: z.array(playwrightSpecSchema).optional(),
    suites: z.array(playwrightSuiteSchema).optional(),
  }),
);
/** The subset of Playwright's JSON reporter output the summary reads. */
export const playwrightReportSchema = z.object({
  suites: z.array(playwrightSuiteSchema),
});

/**
 * Flattens Playwright's JSON report. Spec paths are relative to the test
 * directory, so `testDir` (relative to the repository) prefixes each one.
 */
export function playwrightRecords(
  report: z.infer<typeof playwrightReportSchema>,
  testDir: string,
): TestRecord[] {
  const records: TestRecord[] = [];
  const visit = (suite: PlaywrightSuite, titles: string[]) => {
    const path = suite.title === "" ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        records.push({
          runner: "playwright",
          project: test.projectName,
          file: `${testDir}/${spec.file}`,
          // The top-level suite title is the file name.
          name: [...path.slice(1), spec.title].join(" > "),
          state:
            test.status === "unexpected"
              ? "failed"
              : test.status === "skipped"
                ? "skipped"
                : "passed",
          durationMs: test.results.at(-1)?.duration ?? 0,
          flaky: test.status === "flaky",
          error: test.results.find((result) => result.error)?.error?.message,
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, path);
  };
  for (const suite of report.suites) visit(suite, []);
  return records;
}

/** SDK evidence consumed by both the hosted report and the combined CI summary. */
export const journeyFailureSchema = z.object({
  code: z.string(),
  category: z.string(),
  message: z.string().optional(),
  phase: z.string().optional(),
});
export const journeyReportSchema = z.object({
  run: z.object({
    status: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    summary: z.object({
      discovered: z.number().optional(),
      selected: z.number(),
      executed: z.number(),
      passed: z.number(),
      failed: z.number(),
      skipped: z.number(),
      flaky: z.number(),
    }),
    usage: z
      .object({
        modelTokens: z.number().optional(),
        artifactBytes: z.number().optional(),
      })
      .optional(),
    results: z.array(
      z.object({
        testId: z.string(),
        file: z.string(),
        targetId: z.string(),
        titlePath: z.array(z.string()),
        selected: z.boolean(),
        status: z.string(),
        attempts: z.array(
          z.object({
            status: z.string(),
            startedAt: z.string(),
            durationMs: z.number(),
            error: journeyFailureSchema.optional(),
            artifacts: z
              .array(
                z.object({
                  kind: z.string(),
                  path: z.string().optional(),
                  mediaType: z.string().optional(),
                }),
              )
              .default([]),
            steps: z
              .array(
                z.object({
                  api: z.string(),
                  label: z.string(),
                  status: z.string(),
                  startedAt: z.string(),
                  durationMs: z.number(),
                  cache: z.json().optional(),
                  events: z
                    .array(
                      z.object({
                        kind: z.string(),
                        detail: z.string().optional(),
                      }),
                    )
                    .default([]),
                }),
              )
              .default([]),
          }),
        ),
      }),
    ),
    errors: z.array(z.unknown()),
  }),
});

export function journeyFailureBoundary(
  error: z.infer<typeof journeyFailureSchema> | undefined,
) {
  if (!error) return "unclassified";
  if (/MODEL|PROVIDER|INFERENCE/u.test(error.code)) return "provider";
  if (error.phase && error.phase !== "body") return "startup / fixture";
  if (
    /AGENT|AUTOMATION|BUDGET|STEP_LIMIT/u.test(error.code) ||
    /255 options/u.test(error.message ?? "")
  )
    return "agent";
  return "application / outcome";
}

export function testerArmyRecords(
  report: z.infer<typeof journeyReportSchema>,
): TestRecord[] {
  return report.run.results
    .filter((result) => result.selected)
    .map((result) => {
      const last = result.attempts.at(-1);
      return {
        runner: "tester-army",
        project: result.targetId,
        file: `apps/web/${result.file}`,
        name: result.titlePath.join(" > "),
        state:
          result.status === "passed"
            ? "passed"
            : result.status === "skipped" || !last
              ? "skipped"
              : "failed",
        durationMs: last?.durationMs ?? 0,
        flaky:
          result.status === "passed" &&
          result.attempts.some((attempt) => attempt.status !== "passed"),
        error: last?.error
          ? `${journeyFailureBoundary(last.error)}: ${last.error.code}: ${last.error.message ?? ""}`
          : undefined,
      };
    });
}

export function journeyPassed(
  run: z.infer<typeof journeyReportSchema>["run"],
  fixtureCount: number,
) {
  return (
    run.status === "passed" &&
    run.summary.selected > 0 &&
    run.summary.executed === run.summary.selected &&
    run.summary.failed === 0 &&
    run.summary.skipped === 0 &&
    run.summary.flaky === 0 &&
    run.errors.length === 0 &&
    fixtureCount === run.summary.executed
  );
}

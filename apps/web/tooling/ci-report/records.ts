import { z } from "zod";

/** One test outcome in the combined CI summary, from either runner. */
export const testRecordSchema = z.object({
  runner: z.enum(["vitest", "playwright"]),
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

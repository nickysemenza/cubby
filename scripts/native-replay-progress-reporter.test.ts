// SDK reporter events include selectors, session paths, and fixture IDs. Only
// validated step counters, commands, and elapsed time may reach CI output.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const reporter = new URL(
  "../apps/web/tooling/native-replay-progress-reporter.ts",
  import.meta.url,
);
function output(events: object[]): string {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import reporter from ${JSON.stringify(reporter.href)};
    reporter.onTestStart();
    for (const event of JSON.parse(process.argv[1])) reporter.onTestStep(event);
  `,
      JSON.stringify(events),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("reports the SDK's direct step payload without leaking other event data", () => {
  const stdout = output([
    {
      stepIndex: 7,
      stepTotal: 55,
      stepCommand: "fill",
      stepValue: "synthetic-private-selector",
      session: "synthetic-private-session",
      artifactsDir: "/synthetic/private/artifacts",
    },
  ]);
  assert.match(stdout, /^\[native-replay\] step 7\/55 fill elapsed=\d+ms\n$/);
  assert.doesNotMatch(stdout, /private|selector|session|artifacts/);
});

test("ignores malformed counters, unknown commands, and wrapped payloads", () => {
  assert.equal(
    output([
      { stepIndex: -1, stepTotal: 55, stepCommand: "click" },
      { stepIndex: "7", stepTotal: 55, stepCommand: "click" },
      { stepIndex: 7, stepTotal: 55, stepCommand: "synthetic-private-command" },
      { test: { stepIndex: 7, stepTotal: 55, stepCommand: "click" } },
    ]),
    "",
  );
});

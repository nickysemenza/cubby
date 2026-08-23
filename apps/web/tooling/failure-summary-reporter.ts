import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

/**
 * Re-prints the failing tests as a compact block at the very END of the run,
 * and mirrors the same list to `apps/web/.vitest-failures.txt`.
 *
 * Why this exists: over 21 days of agent transcripts, **560 test runs (24% of
 * all of them, 5.36h) were an immediate re-run of a run that had just failed**,
 * at a median gap of 9 seconds. In **98%** of those cases the failing run had
 * been piped through `tail`/`head`/`grep` — the agent truncated the output to
 * save context, lost which tests actually failed, and paid for the whole tier
 * a second time to find out.
 *
 * Both halves of the fix matter. Printing last is what survives `| tail -20`,
 * which is how the output is nearly always read; the file is what survives a
 * `| grep` that matches nothing, and lets a later turn recover the failures
 * without re-running at all. Neither is a substitute for the default reporter's
 * full diff — this is the index, not the detail.
 */
export default class FailureSummaryReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const lines: string[] = [];

    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests("failed")) {
        const result = testCase.result();
        const message =
          result.state === "failed"
            ? (result.errors[0]?.message ?? "").split("\n")[0]
            : "";
        lines.push(
          `${testModule.relativeModuleId} › ${testCase.fullName}${message ? `\n    ${message}` : ""}`,
        );
      }
    }

    if (lines.length === 0) return;

    const outputPath = join(process.cwd(), ".vitest-failures.txt");
    const body = lines.join("\n");
    let wrote = true;
    try {
      writeFileSync(outputPath, `${body}\n`);
    } catch {
      // A read-only or racing filesystem must never fail the run itself; the
      // stderr block below is the copy that actually gets read.
      wrote = false;
    }

    // Report the path actually written, not a hardcoded one — `cwd` follows
    // wherever vitest was invoked from.
    const alsoAt = wrote
      ? `\n\nAlso written to ${relative(process.cwd(), outputPath)}`
      : "";
    process.stderr.write(
      `\n${"─".repeat(60)}\n${lines.length} FAILING TEST(S) — do not re-run to find them:\n\n${body}${alsoAt}\n${"─".repeat(60)}\n`,
    );
  }
}

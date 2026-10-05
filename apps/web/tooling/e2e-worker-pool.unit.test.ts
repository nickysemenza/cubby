import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const e2eRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests/e2e",
);

// Playwright's built-in worker-scoped options. Overriding any of them with
// `test.use`, even to its default value, changes the fixture pool digest, so
// the spec runs in its own worker processes: a fresh browser, database,
// workerd harness, and sign-in, scheduled after the shared pool's tests.
const builtInWorkerOptions = new Set([
  "browserName",
  "channel",
  "connectOptions",
  "defaultBrowserType",
  "headless",
  "launchOptions",
  "reuseContext",
  "screenshot",
  "trace",
  "video",
]);
// These select a different Worker harness, so their worker split is real.
const harnessWorkerOptions = new Set(["gmailJourney", "purchaseAgent"]);

describe("E2E worker pool", () => {
  it("lets only harness options split a spec into its own workers", () => {
    const overrides = readdirSync(e2eRoot)
      .filter((file) => file.endsWith(".spec.ts"))
      .flatMap((file) =>
        [
          ...readFileSync(path.join(e2eRoot, file), "utf8").matchAll(
            /test\.use\(\s*\{([^}]*)\}/gu,
          ),
        ].flatMap(([, body]) =>
          [...(body ?? "").matchAll(/(\w+)\s*:/gu)].map(
            ([, key]) => `${file}: ${key}`,
          ),
        ),
      );
    // The harness splits stay visible, so a broken scan cannot pass vacuously.
    expect(
      overrides.filter((override) =>
        harnessWorkerOptions.has(override.split(": ")[1] ?? ""),
      ),
    ).not.toEqual([]);
    expect(
      overrides.filter((override) =>
        builtInWorkerOptions.has(override.split(": ")[1] ?? ""),
      ),
    ).toEqual([]);
  });
});

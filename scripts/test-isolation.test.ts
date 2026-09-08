import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Playwright keeps browser contexts test-scoped", () => {
  const fixture = readFileSync("apps/web/tests/e2e/e2e-test.ts", "utf8");
  assert.doesNotMatch(fixture, /cachedContext/u);
  assert.doesNotMatch(fixture, /scope: "worker"/u);
  assert.match(fixture, /const test = base\.extend\(\{/u);
});

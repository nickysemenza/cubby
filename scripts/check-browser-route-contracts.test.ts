import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedBrowserRouteFiles,
  missingBrowserRouteFiles,
} from "./check-browser-route-contracts.ts";

test("every generated list and detail route has a file-route module", () => {
  assert.deepEqual(missingBrowserRouteFiles(), []);
});

test("missing route modules are reported by generated relative path", () => {
  const expected = expectedBrowserRouteFiles();
  const missing = new Set([expected[0], expected.at(-1)]);
  assert.deepEqual(
    missingBrowserRouteFiles((path) =>
      [...missing].every((relativePath) => !path.endsWith(relativePath ?? "")),
    ),
    [...missing],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { localSimulatorServer } from "./lib/simulator-server.ts";

// Failure modes: a launcher silently selects production, or a URL with credentials
// or a non-origin path reaches the app.
for (const url of ["http://localhost:3000", "http://127.0.0.1:3100/"])
  test(`accepts local origin ${url}`, () => {
    assert.equal(localSimulatorServer(url), new URL(url).origin);
  });
for (const url of [
  "https://example.test:3000",
  "http://example.test:3000",
  "http://localhost",
  "http://localhost:3000/api",
  "http://localhost:3000/?x=1",
  "http://localhost:3000/#x",
  "http://synthetic:password@localhost:3000",
  "invalid",
])
  test(`rejects non-local origin ${url}`, () => {
    assert.throws(() => localSimulatorServer(url), /loopback HTTP origin/u);
  });

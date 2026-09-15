import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { closeE2EWorkerResources } from "../apps/web/tooling/e2e-worker-resources.ts";
import { resolveE2EWorkers } from "../apps/web/tooling/e2e-workers.ts";

test("Playwright shares services per worker without sharing browser contexts", () => {
  const fixture = readFileSync("apps/web/tests/e2e/e2e-test.ts", "utf8");
  assert.doesNotMatch(fixture, /cachedContext/u);
  assert.match(fixture, /e2eRuntime:[\s\S]*scope: "worker"/u);
  assert.doesNotMatch(
    fixture,
    /(?:page|context):[\s\S]{0,120}scope: "worker"/u,
  );
});

test("local macOS defaults to three E2E workers while CI defaults to one", () => {
  assert.equal(resolveE2EWorkers({}, "darwin"), 3);
  assert.equal(resolveE2EWorkers({ CI: "1" }, "darwin"), 1);
  assert.equal(resolveE2EWorkers({}, "linux"), 1);
  assert.equal(resolveE2EWorkers({ CUBBY_E2E_WORKERS: "2" }, "linux"), 2);
  assert.throws(
    () => resolveE2EWorkers({ CUBBY_E2E_WORKERS: "4" }, "darwin"),
    /must be 1, 2, or 3/u,
  );
});

test("E2E worker cleanup attempts every acquired resource in order", async () => {
  const closed: string[] = [];
  await assert.rejects(
    closeE2EWorkerResources({
      harness: {
        close: async () => {
          closed.push("harness");
          throw new Error("harness close failed");
        },
      },
      database: {
        close: async () => {
          closed.push("database");
        },
      },
      objectStorage: {
        close: async () => {
          closed.push("object storage");
        },
      },
    }),
    /E2E worker cleanup failed/u,
  );
  assert.deepEqual(closed, ["harness", "database", "object storage"]);
});

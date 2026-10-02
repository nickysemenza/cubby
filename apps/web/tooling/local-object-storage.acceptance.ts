import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureE2ERunIdentity, writeE2ERunBundle } from "./e2e-run-bundle";
import {
  createE2EObjectStorage,
  type E2EObjectStorage,
} from "./local-object-storage";

// HTTP success cannot establish isolation: inspect each real R2 binding independently.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = path.resolve(
  repoRoot,
  process.argv[2] ?? `test-results/local-r2-acceptance/${Date.now()}`,
);
mkdirSync(outputDir, { recursive: true });
const started = captureE2ERunIdentity(repoRoot);
const sourceFiles = [
  "apps/web/tooling/local-object-storage.acceptance.ts",
  "apps/web/tooling/local-object-storage.ts",
  "apps/web/tooling/local-object-storage.worker.ts",
  "apps/web/tooling/dev/storage.ts",
];
const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const sources = sourceFiles.map((file) => ({
  path: file,
  sha256: sha256(readFileSync(path.join(repoRoot, file))),
}));
const key = "e2e/synthetic shared key.bin";
const bytes = [
  Buffer.from([0, 1, 2, 3, 254, 255]),
  Buffer.from([255, 254, 3, 2, 1, 0, 9]),
];
const cases: Array<{ name: string; status: string; durationMs: number }> = [];
const storage: E2EObjectStorage[] = [];
let closedFirst = false;
let failure: unknown;
async function check(name: string, action: () => Promise<void>) {
  const start = performance.now();
  try {
    await action();
    cases.push({
      name,
      status: "passed",
      durationMs: performance.now() - start,
    });
  } catch (error) {
    cases.push({
      name,
      status: "failed",
      durationMs: performance.now() - start,
    });
    throw error;
  }
}
const s3URL = (instance: E2EObjectStorage) =>
  `${instance.url}/e2e-bucket/${encodeURIComponent(key)}`;
const publicURL = (instance: E2EObjectStorage) =>
  `${instance.url}/${key.split("/").map(encodeURIComponent).join("/")}`;
async function verifyBytes(instance: E2EObjectStorage, expected: Buffer) {
  const object = await instance.bucket.get(key);
  assert.ok(object, "Real R2 binding must contain the uploaded object");
  assert.deepEqual(Buffer.from(await object.arrayBuffer()), expected);
  assert.equal(object.httpMetadata?.contentType, "application/octet-stream");
  const response = await fetch(publicURL(instance));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
}
try {
  await check("two simultaneous disposable storage workers start", async () => {
    const opened = await Promise.allSettled([
      createE2EObjectStorage(),
      createE2EObjectStorage(),
    ]);
    for (const result of opened) {
      if (result.status === "fulfilled") storage.push(result.value);
    }
    for (const result of opened) {
      if (result.status === "rejected") throw result.reason;
    }
    assert.equal(storage.length, 2);
    assert.notEqual(storage[0]!.url, storage[1]!.url);
  });
  await check(
    "same-key HTTP uploads persist distinct binary bytes in each real R2 binding",
    async () => {
      await Promise.all(
        storage.map(async (instance, index) => {
          const response = await fetch(s3URL(instance), {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: bytes[index]!,
          });
          assert.equal(response.status, 200);
        }),
      );
      await Promise.all(
        storage.map((instance, index) => verifyBytes(instance, bytes[index]!)),
      );
    },
  );
  await check(
    "deleting one object leaves the other binding and HTTP read intact",
    async () => {
      const response = await fetch(s3URL(storage[0]!), { method: "DELETE" });
      assert.equal(response.status, 204);
      assert.equal(await storage[0]!.bucket.get(key), null);
      assert.equal((await fetch(publicURL(storage[0]!))).status, 404);
      await verifyBytes(storage[1]!, bytes[1]!);
    },
  );
  await check(
    "closing one disposable worker leaves the other instance readable",
    async () => {
      await storage[0]!.close();
      closedFirst = true;
      await verifyBytes(storage[1]!, bytes[1]!);
    },
  );
} catch (error) {
  failure = error;
} finally {
  const cleanup = await Promise.allSettled(
    storage.map((instance, index) =>
      index === 0 && closedFirst ? Promise.resolve() : instance.close(),
    ),
  );
  failure ??= cleanup.find((result) => result.status === "rejected")?.reason;
  writeFileSync(
    path.join(outputDir, "run-results.json"),
    `${JSON.stringify(
      {
        status: failure ? "failed" : "passed",
        cases,
        boundary:
          "HTTP local storage adapter and independent real R2 binding inspection",
        key,
        fixtures: bytes.map((value, index) => ({
          instance: index + 1,
          bytes: value.length,
          sha256: sha256(value),
        })),
        error: failure
          ? failure instanceof Error
            ? failure.message
            : String(failure)
          : undefined,
        limits: [
          "No browser, PostgreSQL, or deployed R2 exercised",
          "Dirty source is not exactly replayable from the recorded commit",
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(outputDir, "tested-sources.json"),
    `${JSON.stringify({ sources, unchangedAtEnd: sources.every((source) => source.sha256 === sha256(readFileSync(path.join(repoRoot, source.path)))) }, null, 2)}\n`,
  );
  const manifest = writeE2ERunBundle({
    repoRoot,
    outputDir,
    evidence: [outputDir],
    kind: "browser",
    started,
    status: failure ? "failed" : "passed",
    cases,
    command: [
      "pnpm",
      "--dir",
      "apps/web",
      "exec",
      "tsx",
      "tooling/local-object-storage.acceptance.ts",
    ],
    profile: "local-r2-system-boundary",
    scenario: "simultaneous-upload-readback-delete-isolation",
    fixture: "synthetic-distinct-binary-bytes",
    fixtureVersion: 1,
  });
  process.stdout.write(`${failure ? "FAIL" : "PASS"}: ${manifest}\n`);
}
if (failure) throw failure;

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processIdentity, processStatus } from "./lib/process-identity.ts";

// PID reuse is death only when both births use the same identity format.
test("distinguishes verified process births, absent PIDs and unknown formats", () => {
  const identity = processIdentity(process.pid);
  assert.ok(identity);
  assert.equal(processStatus(process.pid, identity), "alive");
  assert.equal(
    processStatus(process.pid, identity.replace(/\d{4}$/u, "1900")),
    "dead",
  );
  for (const stored of [
    identity.slice("ps-utc-v1:".length),
    "future-v2:synthetic",
    "",
    undefined,
  ])
    assert.equal(processStatus(process.pid, stored), "unknown");
  assert.equal(processStatus(2147483647, identity), "dead");
});

// A readable PID with an unreadable birth cannot authorize termination/recovery.
test("retains unknown ownership when ps cannot read the process birth", () => {
  const identity = processIdentity(process.pid);
  const directory = mkdtempSync(join(tmpdir(), "cubby-unreadable-ps-"));
  const previous = process.env.PATH;
  try {
    writeFileSync(join(directory, "ps"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    process.env.PATH = directory;
    assert.equal(processStatus(process.pid, identity), "unknown");
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

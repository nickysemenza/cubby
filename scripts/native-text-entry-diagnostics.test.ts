// Failed replay logs disappear with their daemon. Retain numeric commit evidence
// before cleanup without copying field contents, credentials or raw diagnostics.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  readNativeTextEntryDiagnostics,
  readReplayTextEntryDiagnostics,
} from "../apps/web/tooling/native-text-entry-diagnostics.ts";

test("retains numeric commit progress without private runner log content", () => {
  const root = mkdtempSync(join(tmpdir(), "native-text-diagnostics-"));
  try {
    const log = join(root, "runner.log");
    writeFileSync(
      log,
      [
        "synthetic-private credential and field contents",
        "2026-01-02 runner[123:456] [DEBUG-1874] wait start expectedLen=22 route=replacement",
        "[DEBUG-1874] poll t=3000ms observedLen=-1 expectedPrefixLen=-1",
        "[DEBUG-1874] poll t=3500ms observedLen=22 expectedPrefixLen=22",
        "[DEBUG-1874] wait outcome=settled elapsedMs=3501 route=replacement",
      ].join("\n"),
    );
    const result = readNativeTextEntryDiagnostics(log);
    assert.deepEqual(result, {
      schemaVersion: 1,
      events: [
        { phase: "commit-start", expectedLength: 22 },
        {
          phase: "commit-poll",
          elapsedMs: 3000,
          observedLength: -1,
          expectedPrefixLength: -1,
        },
        {
          phase: "commit-poll",
          elapsedMs: 3500,
          observedLength: 22,
          expectedPrefixLength: 22,
        },
        { phase: "commit-result", outcome: "settled", elapsedMs: 3501 },
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /private|credential|runner|2026/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe numbers, malformed records and unrelated file paths", () => {
  const root = mkdtempSync(join(tmpdir(), "native-text-diagnostics-"));
  try {
    const log = join(root, "runner.log");
    writeFileSync(
      log,
      [
        "[DEBUG-1874] wait start expectedLen=99999999999999999999999999 route=replacement",
        "[DEBUG-1874] poll t=-1ms observedLen=1 expectedPrefixLen=1",
        "[DEBUG-1874] poll t=1ms observedLen=-2 expectedPrefixLen=-2",
        "[DEBUG-1874] wait outcome=synthetic-private elapsedMs=1 route=replacement",
        "[DEBUG-1874] wait outcome=notObserved elapsedMs=3001 route=replacement",
      ].join("\n"),
    );
    assert.deepEqual(readNativeTextEntryDiagnostics(log), {
      schemaVersion: 1,
      events: [
        { phase: "commit-result", outcome: "notObserved", elapsedMs: 3001 },
      ],
    });
    const unrelated = join(root, "other.log");
    writeFileSync(
      unrelated,
      "[DEBUG-1874] wait start expectedLen=1 route=replacement",
    );
    assert.equal(readNativeTextEntryDiagnostics(unrelated), undefined);
    assert.equal(
      readNativeTextEntryDiagnostics(join(root, "missing", "runner.log")),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads only the completed replay session before its temporary daemon is removed", () => {
  const root = mkdtempSync(join(tmpdir(), "native-replay-text-"));
  try {
    const daemon = join(root, "agent-device-replay-daemon-synthetic");
    const own = join(daemon, "sessions", "synthetic_own_session");
    const other = join(daemon, "sessions", "synthetic_other_session");
    mkdirSync(own, { recursive: true });
    mkdirSync(other);
    writeFileSync(
      join(own, "runner.log"),
      "[DEBUG-1874] wait start expectedLen=22 route=replacement",
    );
    writeFileSync(
      join(other, "runner.log"),
      "[DEBUG-1874] wait start expectedLen=99 route=replacement",
    );
    assert.deepEqual(
      readReplayTextEntryDiagnostics(root, "synthetic/own/session"),
      {
        schemaVersion: 1,
        events: [{ phase: "commit-start", expectedLength: 22 }],
      },
    );
    assert.equal(
      readReplayTextEntryDiagnostics(root, "missing-session"),
      undefined,
    );
    assert.equal(readReplayTextEntryDiagnostics(root, ".."), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

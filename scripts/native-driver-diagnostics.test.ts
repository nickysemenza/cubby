// Startup traces carry selectors, credentials, paths and device identifiers.
// Projection must discard those, reject malformed records and exclude old runs.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectNativeDriverDiagnostics } from "../apps/web/tooling/native-driver-diagnostics.ts";

test("projects SDK startup traces to fixed phases and numeric timings", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-diagnostics-"));
  try {
    mkdirSync(join(root, "logs"));
    writeFileSync(
      join(root, "logs", "startup.ndjson"),
      JSON.stringify({
        ts: "2026-01-02T03:04:05.000Z",
        phase: "apple_runner_prepare",
        durationMs: 350,
        command: "prepare",
        session: "synthetic-private-session",
        data: {
          cache: "exact",
          artifact: "valid",
          buildMs: 0,
          connectMs: 300,
          healthCheckMs: 50,
          deviceId: "synthetic-private-device",
          failureReason: "synthetic-private-credential",
          xctestrunPath: "/synthetic/private/runner",
          timings: { ensure_booted: 4, private_selector: "synthetic-private" },
        },
      }),
    );
    const result = await collectNativeDriverDiagnostics(
      root,
      "2026-01-02T03:00:00.000Z",
    );
    assert.deepEqual(result, {
      schemaVersion: 1,
      events: [
        {
          phase: "apple_runner_prepare",
          command: "prepare",
          durationMs: 350,
          data: {
            cache: "exact",
            artifact: "valid",
            buildMs: 0,
            connectMs: 300,
            healthCheckMs: 50,
            timings: { ensure_booted: 4 },
          },
        },
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /private|device|session|credential|runnerPath/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores old, incomplete, malformed and unsupported diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-diagnostics-"));
  try {
    mkdirSync(join(root, "sessions"));
    writeFileSync(
      join(root, "sessions", "request.ndjson"),
      [
        "{",
        JSON.stringify({
          ts: "2025-01-01T00:00:00.000Z",
          phase: "apple_runner_prepare",
          durationMs: 1,
        }),
        JSON.stringify({
          ts: "2026-01-02T03:04:05.000Z",
          phase: "synthetic-private-phase",
          durationMs: 1,
        }),
        JSON.stringify({
          ts: "2026-01-02T03:04:05.000Z",
          phase: "exec_command",
          durationMs: -1,
        }),
        JSON.stringify({
          ts: "2026-01-02T03:04:05.000Z",
          phase: "exec_command",
          data: { error: "synthetic-private" },
        }),
      ].join("\n"),
    );
    assert.deepEqual(
      await collectNativeDriverDiagnostics(root, "2026-01-02T03:00:00.000Z"),
      {
        schemaVersion: 1,
        events: [{ phase: "exec_command", data: {} }],
      },
    );
    assert.deepEqual(
      await collectNativeDriverDiagnostics(
        join(root, "missing"),
        "2026-01-02T03:00:00.000Z",
      ),
      {
        schemaVersion: 1,
        events: [],
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

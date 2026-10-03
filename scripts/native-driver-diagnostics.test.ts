// Startup traces carry selectors, credentials, paths and device identifiers.
// Projection must discard those, reject malformed records and exclude old runs.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  collectNativeDriverDiagnostics,
  projectNativeNavigationSnapshot,
} from "../apps/web/tooling/native-driver-diagnostics.ts";

// A failure snapshot can contain records and credentials. Retain only geometry
// and state for the fixed navigation controls; malformed facts remain absent.
test("projects navigation state without exporting snapshot content", () => {
  const result = projectNativeNavigationSnapshot({
    success: true,
    token: "synthetic-secret",
    data: {
      appName: "synthetic-private-app",
      nodes: [
        { type: "Window", rect: { x: 0, y: 0, width: 400, height: 900 } },
        {
          type: "Button",
          label: "Find",
          selected: false,
          hittable: true,
          rect: {
            x: 320,
            y: 800,
            width: 70,
            height: 50,
            secret: "synthetic-secret",
          },
          identifier: "synthetic-private-id",
          value: "synthetic-private-value",
        },
        { type: "NavigationBar", label: "Search" },
        { type: "Button", label: "Search Cubby" },
        {
          type: "SearchField",
          label: "Search Cubby",
          value: "synthetic-private-query",
        },
        { type: "StaticText", label: "synthetic-private-record" },
      ],
    },
  });
  assert.equal(result.status, "available");
  if (result.status !== "available")
    throw new Error("Missing navigation facts");
  assert.equal(result.findButtonCount, 1);
  assert.equal(result.searchFieldCount, 1);
  assert.equal(result.searchButtonCount, 1);
  assert.equal(result.searchNavigationCount, 1);
  assert.deepEqual(result.findButtons, [
    {
      selected: false,
      hittable: true,
      rect: { x: 320, y: 800, width: 70, height: 50 },
    },
  ]);
  assert.ok(!JSON.stringify(result).includes("synthetic-private"));
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
});

test("bounds geometry output and refuses malformed snapshot envelopes", () => {
  const nodes = Array.from({ length: 30 }, () => ({
    kind: "button",
    label: "Find",
    selected: "synthetic-private-value",
    rect: { x: Infinity, y: 0, width: 0, height: 0 },
  }));
  const result = projectNativeNavigationSnapshot({ nodes });
  if (result.status !== "available")
    throw new Error("Missing bounded navigation facts");
  assert.equal(result.findButtonCount, 30);
  assert.equal(result.findButtons.length, 8);
  assert.ok(
    result.findButtons.every(
      (node) => node.rect === undefined && node.selected === undefined,
    ),
  );
  assert.equal(
    projectNativeNavigationSnapshot({
      data: { nodes: "synthetic-private-value" },
    }).status,
    "unavailable",
  );
});

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

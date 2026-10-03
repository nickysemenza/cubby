import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

import { replaySessionRoots } from "./native-replay-session.ts";

import { walkFiles } from "../../../scripts/lib/tree-digest.ts";

const milliseconds = z.number().finite().nonnegative();
const rectangleSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
const navigationNodeSchema = z.object({
  type: z.string().optional(),
  kind: z.string().optional(),
  label: z.string().optional(),
  rect: rectangleSchema.optional().catch(undefined),
  selected: z.boolean().optional().catch(undefined),
  enabled: z.boolean().optional().catch(undefined),
  hittable: z.boolean().optional().catch(undefined),
});
const navigationSnapshotSchema = z.object({
  nodes: z.array(navigationNodeSchema).max(5_000),
});
const navigationFactsSchema = navigationNodeSchema.pick({
  rect: true,
  selected: true,
  enabled: true,
  hittable: true,
});

// A raw snapshot can contain record values, identifiers and credentials. Expose
// only fixed control counts and bounded geometry, including off-screen rects.
export function projectNativeNavigationSnapshot(payload: unknown) {
  const parsed = z
    .union([
      navigationSnapshotSchema,
      z.object({
        success: z.literal(true).optional(),
        data: navigationSnapshotSchema,
      }),
    ])
    .safeParse(payload);
  if (!parsed.success) return { status: "unavailable" } as const;
  const { nodes } = "data" in parsed.data ? parsed.data.data : parsed.data;
  const hasRole = (node: z.infer<typeof navigationNodeSchema>, role: string) =>
    [node.kind, node.type].some(
      (value) => value?.replaceAll("-", "").toLowerCase() === role,
    );
  const find = nodes.filter(
    (node) => node.label === "Find" && hasRole(node, "button"),
  );
  return {
    status: "available",
    findButtonCount: find.length,
    findButtons: find
      .slice(0, 8)
      .map((node) => navigationFactsSchema.parse(node)),
    searchFieldCount: nodes.filter((node) => hasRole(node, "searchfield"))
      .length,
    searchButtonCount: nodes.filter(
      (node) =>
        hasRole(node, "button") &&
        ["Search", "Search Cubby"].includes(node.label ?? ""),
    ).length,
    searchNavigationCount: nodes.filter(
      (node) => hasRole(node, "navigationbar") && node.label === "Search",
    ).length,
    windowRects: nodes
      .filter((node) => hasRole(node, "window") && node.rect !== undefined)
      .slice(0, 8)
      .map((node) => node.rect),
  } as const;
}
const timingSchema = z.object({
  adopt_detached_runner: milliseconds.optional(),
  allocate_port: milliseconds.optional(),
  cleanup_stale_bundles: milliseconds.optional(),
  cleanup_stale_xcodebuild: milliseconds.optional(),
  ensure_booted: milliseconds.optional(),
  ensure_xctestrun: milliseconds.optional(),
  launch_xcodebuild: milliseconds.optional(),
  prepare_xctestrun_env: milliseconds.optional(),
  stop_expired_starting_session: milliseconds.optional(),
  stop_other_simulator_set_session: milliseconds.optional(),
  stop_stale_artifact_session: milliseconds.optional(),
  stop_stale_session: milliseconds.optional(),
  verify_device_readiness: milliseconds.optional(),
  verify_host_dev_tools_security: milliseconds.optional(),
});
const eventSchema = z.object({
  ts: z.iso.datetime({ offset: true }),
  phase: z.enum([
    "ios.snapshot-source.prepare",
    "ios.snapshot-source.acquire",
    "exec_command",
    "daemon_startup",
    "daemon_request_timeout",
    "apple_runner_prepare",
    "ios_runner_session_startup",
    "ios_runner_session_startup_timings",
    "ios_runner_session_reuse",
    "ios_runner_lease_adopted",
    "ios_runner_lease_adoption_probe",
    "ios_runner_lease_adoption_skipped",
    "ios_runner_prepare_bad_cache_recovered",
    "ios_runner_prepare_health_retry",
    "ios_runner_recycle_budget_exhausted",
    "ios_runner_session_artifact_stale",
    "ios_runner_session_prewarm_unavailable",
  ]),
  command: z
    .enum([
      "prepare",
      "open",
      "wait",
      "find",
      "snapshot",
      "test",
      "click",
      "fill",
      "is",
      "close",
    ])
    .optional(),
  durationMs: milliseconds.optional(),
  data: z
    .object({
      cache: z.enum(["exact", "miss", "external"]).optional(),
      artifact: z.enum(["valid", "rebuilt"]).optional(),
      buildMs: milliseconds.optional(),
      connectMs: milliseconds.optional(),
      healthCheckMs: milliseconds.optional(),
      timings: timingSchema.optional(),
    })
    .optional(),
});

function projectDiagnosticLine(line: string, threshold = 0) {
  if (line.length > 100_000) return;
  try {
    const parsed = eventSchema.safeParse(JSON.parse(line));
    if (!parsed.success || Date.parse(parsed.data.ts) < threshold) return;
    const { ts: _timestamp, ...event } = parsed.data;
    return event;
  } catch {
    return;
  }
}

// Reporter callbacks are not awaited. Read a bounded prefix and tail of only
// this session's requests before SDK cleanup, retaining the same projection.
export function readReplayDriverDiagnostics(
  temporaryRoot: string,
  session: string,
) {
  const events: Omit<z.infer<typeof eventSchema>, "ts">[] = [];
  for (const directory of replaySessionRoots(temporaryRoot, session)) {
    let files: string[];
    try {
      files = walkFiles(join(directory, "requests"))
        .filter((file) => file.endsWith(".ndjson"))
        .slice(0, 20);
    } catch {
      continue;
    }
    for (const file of files) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(descriptor);
        if (!stat.isFile()) continue;
        const length = Math.min(stat.size, 256_000);
        const buffer = Buffer.alloc(length);
        const prefix = stat.size > length ? length / 2 : length;
        const bytes = readSync(descriptor, buffer, 0, prefix, 0);
        const tail =
          stat.size > length
            ? readSync(
                descriptor,
                buffer,
                prefix,
                length - prefix,
                stat.size - (length - prefix),
              )
            : 0;
        const content =
          buffer.subarray(0, bytes).toString("utf8") +
          "\n" +
          buffer.subarray(prefix, prefix + tail).toString("utf8");
        for (const line of content.split(/\r?\n/u)) {
          const event = projectDiagnosticLine(line);
          if (event) events.push(event);
          if (events.length >= 1_000) return { schemaVersion: 1, events };
        }
      } catch {
        // A disappearing or unreadable trace must not change the test result.
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    if (events.length) return { schemaVersion: 1, events };
  }
}

// SDK traces contain argv, responses, credentials, selectors and device/session
// identifiers. Serialize only the schema projection, never an original record.
export async function collectNativeDriverDiagnostics(
  sdkRoot: string,
  startedAt: string,
) {
  const threshold = Date.parse(
    z.iso.datetime({ offset: true }).parse(startedAt),
  );
  const events: Omit<z.infer<typeof eventSchema>, "ts">[] = [];
  const files = ["logs", "sessions"].flatMap((directory) =>
    walkFiles(join(sdkRoot, directory)).filter((file) =>
      file.endsWith(".ndjson"),
    ),
  );
  for (const file of files) {
    const stream = createReadStream(file);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const event = projectDiagnosticLine(line, threshold);
        if (event) events.push(event);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return { schemaVersion: 1, events };
}

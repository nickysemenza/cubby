import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

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
        if (line.length > 100_000) continue;
        let parsed: ReturnType<typeof eventSchema.safeParse>;
        try {
          parsed = eventSchema.safeParse(JSON.parse(line));
        } catch {
          continue;
        }
        if (!parsed.success || Date.parse(parsed.data.ts) < threshold) continue;
        const { ts: _timestamp, ...event } = parsed.data;
        events.push(event);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return { schemaVersion: 1, events };
}

import { CF_ACCOUNT_ID } from "@cubby/shared/ai/gateway-metadata";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import { z } from "zod";

import type { JobLogLine, JobLogsOut } from "~/contracts/job.contract";
import { env } from "~/env";
import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";

import { readJobWindow } from "../repo/job-diagnostics";

/** Workers Logs keeps raw lines this long. */
export const WORKERS_LOGS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Lines one panel read returns; the count says how many matched. */
const JOB_LOG_LINE_LIMIT = 500;
/** Lines just outside the Job's rows (claim, enqueue) still belong to it. */
const WINDOW_MARGIN_MS = 60_000;

const QUERY_PATH = `/accounts/${CF_ACCOUNT_ID}/workers/observability/telemetry/query`;
const OBSERVABILITY_DASHBOARD_URL = `https://dash.cloudflare.com/${CF_ACCOUNT_ID}/workers-and-pages/observability`;

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * The structured Job log fields (`jobId`, `runId`) are top-level keys of the
 * one JSON object `@cubby/worker-tracing` logs, which Workers Logs indexes.
 */
function jobLogQuery(input: {
  jobId: string;
  runId: string | null;
  from: number;
  to: number;
}) {
  const field = (key: string, value: string) => ({
    key,
    operation: "eq",
    type: "string",
    value,
  });
  return {
    queryId: `cubby-job-logs-${input.jobId}`,
    view: "events",
    dry: true,
    limit: JOB_LOG_LINE_LIMIT,
    timeframe: { from: input.from, to: input.to },
    parameters: {
      datasets: [],
      filterCombination: "or",
      filters: [
        field("jobId", input.jobId),
        ...(input.runId ? [field("runId", input.runId)] : []),
      ],
    },
  };
}

const telemetryEvent = z.looseObject({
  $metadata: z.looseObject({
    id: z.string(),
    message: z.string().optional(),
    level: z.string().optional(),
    error: z.string().optional(),
  }),
  timestamp: z.number(),
  source: z.union([z.string(), z.record(z.string(), z.unknown())]),
});
const telemetryResponse = z.looseObject({
  result: z
    .looseObject({
      events: z
        .looseObject({
          count: z.number().optional(),
          events: z.array(telemetryEvent).optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Logger envelope keys the line already shows. */
const ENVELOPE = new Set(["message", "level", "scope"]);

function lineOf(event: z.infer<typeof telemetryEvent>): JobLogLine {
  const source = typeof event.source === "string" ? null : event.source;
  const rest = source
    ? Object.fromEntries(
        Object.entries(source).filter(([key]) => !ENVELOPE.has(key)),
      )
    : null;
  const message =
    event.$metadata.message ??
    (typeof event.source === "string" ? event.source : "");
  return {
    id: event.$metadata.id,
    timestamp: event.timestamp,
    level:
      event.$metadata.level === "log"
        ? "info"
        : (event.$metadata.level ?? "info"),
    message: scrubErrorMessage(message),
    fields:
      rest && Object.keys(rest).length
        ? scrubErrorMessage(JSON.stringify(rest))
        : null,
  };
}

export type LogDeps = {
  token: string | undefined;
  fetch: typeof fetch;
  now: () => number;
};

// The AI Gateway token also carries Workers Observability Edit, which the
// telemetry query endpoint requires even for reads.
const productionDeps = (): LogDeps => ({
  token: env.AI_GATEWAY_API_KEY || undefined,
  fetch: (input, init) => fetch(input, init),
  now: Date.now,
});

/**
 * One Job's raw Worker log lines over its active window. Missing token,
 * expired retention and query failures are states, never thrown: the panel
 * shows each with the dashboard link.
 */
export async function readJobLogs(
  db: Database,
  jobId: string,
  deps: LogDeps = productionDeps(),
): Promise<JobLogsOut> {
  const window = await readJobWindow(db, jobId);
  if (!window) throw new Error(`Job ${jobId} does not exist`);
  return queryJobLogs(window, deps);
}

/** The log read for one Job's stored window. */
export async function queryJobLogs(
  window: {
    id: string;
    runId: string | null;
    state: string;
    createdAt: Date;
    updatedAt: Date;
  },
  deps: LogDeps,
): Promise<JobLogsOut> {
  const jobId = window.id;
  const dashboardUrl = OBSERVABILITY_DASHBOARD_URL;
  if (!deps.token) return { status: "not_configured", dashboardUrl };
  const now = deps.now();
  const end = TERMINAL.has(window.state) ? window.updatedAt.getTime() : now;
  const range = {
    from: window.createdAt.getTime() - WINDOW_MARGIN_MS,
    to: Math.min(now, end + WINDOW_MARGIN_MS),
  };
  const retained = now - WORKERS_LOGS_RETENTION_MS;
  if (range.to <= retained)
    return { status: "expired", window: range, dashboardUrl };
  const from = Math.max(range.from, retained);
  const request = `POST ${QUERY_PATH}`;
  try {
    const response = await deps.fetch(
      `https://api.cloudflare.com/client/v4${QUERY_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          jobLogQuery({ jobId, runId: window.runId, from, to: range.to }),
        ),
      },
    );
    const body = await response.text();
    if (!response.ok)
      return {
        status: "error",
        request: `${request} → ${response.status} ${response.statusText}`,
        message: scrubErrorMessage(body),
        dashboardUrl,
      };
    const parsed = telemetryResponse.parse(JSON.parse(body));
    const events = parsed.result?.events?.events ?? [];
    return {
      status: "ok",
      lines: events.map(lineOf).sort((a, b) => a.timestamp - b.timestamp),
      count: parsed.result?.events?.count ?? events.length,
      window: { from, to: range.to },
      dashboardUrl,
    };
  } catch (error) {
    return {
      status: "error",
      request,
      message: scrubErrorMessage(JSON.stringify(describeErrorCauses(error))),
      dashboardUrl,
    };
  }
}

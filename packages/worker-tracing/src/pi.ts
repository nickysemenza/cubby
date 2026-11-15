import type {
  SpanAttributes,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";

import { loadWorkerTracing, type SpanAttr, type WorkerSpan } from "./index";
import { enterSpan, NOOP_TRACE_SPAN } from "./span";

// Pi telemetry is content-free, but an adapter must not export a new payload
// attribute or provider error message merely because an SDK starts supplying it.
const metadataKeys = new Set([
  "provider",
  "api",
  "model",
  "reasoning",
  "stop",
  "usage.input",
  "usage.output",
  "usage.cache_read",
  "usage.cache_write",
  "cost.total",
  "response.id",
  "type",
  "index",
  "chars",
  "tool",
  "tool.name",
  "tool.call_id",
  "task.id",
  "task.name",
  "phase",
  "kind",
  "attempt",
  "resumed",
  "outcome",
  "submission.type",
  "submission.id",
  "conversation.id",
  "result",
  "entry.id",
  "entry.kind",
  "status",
  "answer.entry_id",
  "reason",
  "extension",
]);

function recordMetadata(
  span: WorkerSpan,
  attributes: SpanAttributes | undefined,
  prefix = "",
) {
  for (const [key, value] of Object.entries(attributes ?? {}))
    if (
      metadataKeys.has(key) &&
      (value === undefined ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    )
      span.setAttribute(`${prefix}${key}`, value);
}

/** Native invocation context owns parenting; no trace carrier survives a wake. */
export async function piTelemetry(
  attributes: () => Record<string, SpanAttr> = () => ({}),
): Promise<TelemetryContext> {
  const tracing = await loadWorkerTracing();
  const context: TelemetryContext = {
    startSpan(options, callback) {
      const run = async (native: WorkerSpan) => {
        recordMetadata(native, options.attributes);
        const events = new Map<string, number>();
        const span: TelemetrySpan = {
          ...context,
          // Native Workers traces have no link/event API. Event metadata is
          // bounded to the last event of each SDK name, with a total count.
          addLink() {},
          addEvent(name, eventAttributes) {
            const count = (events.get(name) ?? 0) + 1;
            events.set(name, count);
            native.setAttribute(`event.${name}.count`, count);
            recordMetadata(native, eventAttributes, `event.${name}.`);
          },
          setAttributes: (next) => recordMetadata(native, next),
          setStatus(status) {
            native.setAttribute("status", status.status);
            if (status.status === "error") native.setError();
          },
        };
        return callback(span);
      };
      // Pi installs its observer inside this callback and can report a setup
      // failure immediately after startSpan returns. Never await before run.
      return tracing
        ? enterSpan(tracing, options.name, run, { attributes: attributes() })
        : run(NOOP_TRACE_SPAN);
    },
  };
  return context;
}

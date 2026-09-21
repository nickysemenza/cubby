import { createRequire } from "node:module";

// Opt-in: `getNodeAutoInstrumentations()` patches ~40 modules at startup, and
// measured on this preload that is ~1.6s of every `pnpm dev` — against 0.02s
// for the Sentry half below. Almost no dev session actually reads the Jaeger
// traces, so the common path shouldn't pay for them. Set CUBBY_OTEL=1 (and
// bring up the Jaeger container: `docker compose -p cubby --profile tracing
// up -d`) when you do want them.
//
// Initialize OTEL before Sentry so Jaeger gets the global tracer provider.
// Sentry.init() registers its own tracer provider, which would block ours.
if (process.env.CUBBY_OTEL === "1") {
  const require = createRequire(import.meta.url);
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { resourceFromAttributes } = require("@opentelemetry/resources");
  const {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
  } = require("@opentelemetry/semantic-conventions");
  const {
    OTLPTraceExporter,
  } = require("@opentelemetry/exporter-trace-otlp-http");
  const {
    getNodeAutoInstrumentations,
  } = require("@opentelemetry/auto-instrumentations-node");
  // Required lazily alongside the rest: a static ESM import would pull
  // @opentelemetry/core in even when this block is skipped, which is most runs.
  const {
    CompositePropagator,
    W3CBaggagePropagator,
    W3CTraceContextPropagator,
  } = require("@opentelemetry/core");

  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "cubby",
      [ATTR_SERVICE_VERSION]: "1.0.0",
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${otlpEndpoint}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
    textMapPropagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  });

  sdk.start();
  console.log(
    `[OTel] OpenTelemetry SDK initialized, exporting to ${otlpEndpoint}`,
  );
}

// The DSN module is a bare constant in a workspace package; Node 24 strips its
// types natively (the symlink resolves outside node_modules), so this preload
// shares the single definition instead of keeping a copy in sync.
import { CUBBY_SENTRY_DSN } from "@cubby/worker-tracing/sentry-dsn";
import * as Sentry from "@sentry/tanstackstart-react";

Sentry.init({
  dsn: CUBBY_SENTRY_DSN,
  sendDefaultPii: false,
  // Unconditionally "development": this preload is wired into the `dev` script
  // only (`NODE_OPTIONS='--import ./instrument.server.mjs' vite dev`), so it
  // never runs in a deployed worker. Without it the SDK defaults to
  // "production" and dev SSR errors are indistinguishable from real ones.
  environment: "development",
  // Disable Sentry tracing in dev — the NodeSDK above handles tracing for Jaeger.
  // Sentry's tracer provider conflicts, causing DB spans to land in separate traces.
  tracesSampleRate: 0,
});

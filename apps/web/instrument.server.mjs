import { createRequire } from "node:module";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

// Initialize OTEL before Sentry so Jaeger gets the global tracer provider.
// Sentry.init() registers its own tracer provider, which would block ours.
{
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

import * as Sentry from "@sentry/tanstackstart-react";

Sentry.init({
  // Keep in sync with SENTRY_DSN in src/lib/sentry-dsn.ts — this preload runs
  // via `node --import` before TS transpilation, so it can't import that module.
  dsn: "https://a50b2f76dd1586f95cdd29cd13a6c0dc@o83311.ingest.us.sentry.io/4508775559135232",
  sendDefaultPii: true,
  // Disable Sentry tracing in dev — the NodeSDK above handles tracing for Jaeger.
  // Sentry's tracer provider conflicts, causing DB spans to land in separate traces.
  tracesSampleRate: 0,
});

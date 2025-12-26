import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

/**
 * Initialize OpenTelemetry instrumentation
 * Must be called before any other imports to ensure proper instrumentation
 */
export function initializeTracing() {
  const sdk = new NodeSDK({
    serviceName: "usda-api",
    traceExporter: new OTLPTraceExporter({
      url:
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
        "http://localhost:4318/v1/traces",
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
        ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS)
        : {},
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable instrumentations that aren't needed or cause issues
        "@opentelemetry/instrumentation-fs": {
          enabled: false, // Can be very noisy
        },
        // HTTP server spans are handled by @hono/otel
        "@opentelemetry/instrumentation-http": {
          enabled: false,
        },
      }),
    ],
  });

  sdk.start();

  // Graceful shutdown
  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => console.log("Tracing terminated"))
      .catch((error: unknown) =>
        console.error("Error terminating tracing", error),
      );
  });

  console.log("OpenTelemetry instrumentation initialized");
}

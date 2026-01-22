/**
 * OpenTelemetry instrumentation for TanStack Start
 * This file should be imported early in the server entry point.
 *
 * Note: This only works in Node.js environments (dev mode).
 * Cloudflare Workers have their own tracing via wrangler.
 *
 * Environment variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP endpoint (default: http://localhost:4318)
 */

import { createRequire } from "node:module";
import { trace } from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

let initialized = false;

export const initOpenTelemetry = () => {
  // Skip if already initialized or not in Node.js
  if (initialized || typeof process === "undefined") {
    return;
  }

  // Skip in Cloudflare Workers (no process.versions.node)
  if (!process.versions?.node) {
    return;
  }

  // Skip on Vercel - OTel packages aren't bundled for serverless
  if (process.env.VERCEL) {
    return;
  }

  initialized = true;

  try {
    // Use createRequire for CJS modules in ESM context
    // These packages are externalized in vite.config.ts
    const require = createRequire(import.meta.url);

    const { NodeSDK } =
      require("@opentelemetry/sdk-node") as typeof import("@opentelemetry/sdk-node");
    const { resourceFromAttributes } =
      require("@opentelemetry/resources") as typeof import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
      require("@opentelemetry/semantic-conventions") as typeof import("@opentelemetry/semantic-conventions");
    const { OTLPTraceExporter } =
      require("@opentelemetry/exporter-trace-otlp-http") as typeof import("@opentelemetry/exporter-trace-otlp-http");
    const { getNodeAutoInstrumentations } =
      require("@opentelemetry/auto-instrumentations-node") as typeof import("@opentelemetry/auto-instrumentations-node");

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
          // Disable fs instrumentation to reduce noise
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

    // Graceful shutdown
    process.on("SIGTERM", () => {
      sdk
        .shutdown()
        .then(() => console.log("[OTel] SDK shut down"))
        .catch((err) => console.error("[OTel] Shutdown error:", err));
    });
  } catch (error) {
    console.warn("[OTel] Failed to initialize OpenTelemetry:", error);
  }
};

// Re-export tracer utilities from tracing.ts
export { getTracer, TraceNames, withTrace } from "./server/tracing";

// Export a function to get the current tracer
export const getInstrumentationTracer = () => trace.getTracer("cubby");

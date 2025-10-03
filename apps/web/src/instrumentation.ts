import { FetchInstrumentation, registerOTel } from "@vercel/otel";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { W3CBaggagePropagator } from "@opentelemetry/core";
import { CompositePropagator } from "@opentelemetry/core";

export function register() {
  // ReferenceError: An error occurred while loading instrumentation hook: global is not defined
  // at i9.enable (.next/server/edge-instrumentation.js:13:50029)
  // at new e (.next/server/edge-instrumentation.js:13:47786)
  // at new i9 (.next/server/edge-instrumentation.js:13:49747)
  // at Module.at (.next/server/edge-instrumentation.js:13:50261)
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  registerOTel({
    serviceName: "recipehub",
    instrumentations: [new FetchInstrumentation()],
    propagators: [
      new CompositePropagator({
        propagators: [
          new W3CTraceContextPropagator(),
          new W3CBaggagePropagator(),
        ],
      }),
    ],
  });
}

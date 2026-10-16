import { batchResultSchema } from "@cubby/schemas/batch";
import superjson from "superjson";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import { superJsonResultSchema } from "~/lib/superjson-wire";
import {
  unparsedStartOperationDataSchema,
  unparsedStartOperationResultSchema,
} from "~/server/operation-runtime/start-operation.contract";

import { percentile, readDatabaseTiming } from "./read-performance-metrics";

const querySchema = z
  .object({
    operation: z
      .string()
      .refine(
        (name) => startOperationDefinitionFor(name)?.kind === "query",
        "Only registered queries can be measured",
      ),
    input: unparsedStartOperationDataSchema,
  })
  .strict();
export const readOperationInputSchema = z.union([
  querySchema,
  z.object({ batch: z.array(querySchema).min(1).max(20) }).strict(),
]);
const lineSchema = z.object({
  i: z.number().int().nonnegative(),
  r: superJsonResultSchema,
});
const settlementSchema = batchResultSchema(unparsedStartOperationResultSchema);

class InvalidOperationResponse extends Error {}

/** One attempt, without browser retries or fallback hiding its actual failures. */
export async function measureOperationRead(
  input: z.input<typeof readOperationInputSchema>,
  origin: URL,
  headers: Headers,
) {
  const request = readOperationInputSchema.parse(input);
  const batch = "batch" in request;
  const items = batch ? request.batch : [request];
  const results: {
    operation: string;
    ok: boolean;
    settledMs: number | null;
    errorKind: "missing" | "batch" | "operation" | null;
    errorCode: string | null;
    requestId: string | null;
  }[] = items.map((item) => ({
    operation: item.operation,
    ok: false,
    settledMs: null,
    errorKind: "missing",
    errorCode: null,
    requestId: null,
  }));
  const started = performance.now();
  let response: Response | undefined;
  let firstResponseMs: number | null = null;
  let responseBodyBytes: number | null = null;
  let bodyComplete = false;
  let failure: "transport" | "http" | "protocol" | null = null;
  const seen = new Set<number>();

  const record = (
    index: number,
    result: z.output<typeof unparsedStartOperationResultSchema> | null,
  ) => {
    const item = items[index];
    if (!item || seen.has(index)) throw new InvalidOperationResponse();
    seen.add(index);
    results[index] = {
      operation: item.operation,
      ok: result?.ok ?? false,
      settledMs: performance.now() - started,
      errorKind: result === null ? "batch" : result.ok ? null : "operation",
      errorCode: result && !result.ok ? result.error.code : null,
      requestId: result && !result.ok ? (result.error.requestId ?? null) : null,
    };
  };
  const decode = (text: string) => {
    try {
      const json: unknown = JSON.parse(text);
      if (batch) {
        const { i, r } = lineSchema.parse(json);
        const result = settlementSchema.parse(superjson.deserialize(r));
        record(i, result.ok ? result.value : null);
      } else {
        record(
          0,
          unparsedStartOperationResultSchema.parse(
            superjson.deserialize(superJsonResultSchema.parse(json)),
          ),
        );
      }
    } catch {
      throw new InvalidOperationResponse();
    }
  };

  try {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    response = await fetch(new URL(BROWSER_OPERATION_PATH, origin), {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(superjson.serialize(request)),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    firstResponseMs = performance.now() - started;
    responseBodyBytes = 0;
    if (!response.ok) {
      failure = "http";
      responseBodyBytes = (await response.arrayBuffer()).byteLength;
      bodyComplete = true;
    } else {
      if (
        batch &&
        !response.headers.get("content-type")?.includes("application/x-ndjson")
      )
        throw new InvalidOperationResponse();
      if (!response.body) throw new InvalidOperationResponse();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          responseBodyBytes += value.byteLength;
          buffered += decoder.decode(value, { stream: true });
          if (batch) {
            for (
              let newline = buffered.indexOf("\n");
              newline !== -1;
              newline = buffered.indexOf("\n")
            ) {
              const line = buffered.slice(0, newline);
              buffered = buffered.slice(newline + 1);
              if (line) decode(line);
            }
          }
        }
        bodyComplete = true;
        buffered += decoder.decode();
        if (batch) {
          // The browser only delivers newline-terminated lines; reject a lost tail.
          if (buffered.trim() || seen.size !== items.length)
            throw new InvalidOperationResponse();
        } else decode(buffered);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  } catch (error) {
    failure =
      error instanceof InvalidOperationResponse ? "protocol" : "transport";
  }
  return {
    success: failure === null && results.every((result) => result.ok),
    failure,
    status: response?.status ?? null,
    version: response?.headers.get("x-cubby-worker-version") ?? null,
    requestId: response?.headers.get("x-request-id") ?? null,
    firstResponseMs,
    completeMs: performance.now() - started,
    responseBodyBytes,
    bodyComplete,
    ...readDatabaseTiming(response?.headers ?? new Headers()),
    cpuMs: null,
    results,
  };
}

/** Only aggregate evidence is public; inputs, bodies and error messages never leave the decoder. */
export function summarizeOperationReads(
  samples: Awaited<ReturnType<typeof measureOperationRead>>[],
) {
  const successful = samples.filter((sample) => sample.success);
  const outcomes = samples.flatMap((sample) => sample.results);
  const metric = (
    field:
      | "sqlCount"
      | "acquisitionMs"
      | "queryActiveWallMs"
      | "clientQueueActiveWallMs",
  ) => {
    const available = samples.flatMap((sample) => {
      const value = sample[field];
      return value === null ? [] : [value];
    });
    return {
      observedRequests: available.length,
      totalRequests: samples.length,
      median: percentile(available, 0.5),
    };
  };
  return {
    versions: [
      ...new Set(
        samples.flatMap((sample) => (sample.version ? [sample.version] : [])),
      ),
    ],
    requests: {
      attempted: samples.length,
      successful: successful.length,
      httpFailures: samples.filter((sample) => sample.failure === "http")
        .length,
      transportFailures: samples.filter(
        (sample) => sample.failure === "transport",
      ).length,
      protocolFailures: samples.filter(
        (sample) => sample.failure === "protocol",
      ).length,
      rpcFailures: samples.filter(
        (sample) => sample.failure === null && !sample.success,
      ).length,
      successfulCompleteMedianMs: percentile(
        successful.map((sample) => sample.completeMs),
        0.5,
      ),
      successfulBodyMedianBytes: percentile(
        successful.flatMap((sample) =>
          sample.responseBodyBytes === null ? [] : [sample.responseBodyBytes],
        ),
        0.5,
      ),
      databasePerRequest: {
        sqlCount: metric("sqlCount"),
        acquisitionMs: metric("acquisitionMs"),
        queryActiveWallMs: metric("queryActiveWallMs"),
        clientQueueActiveWallMs: metric("clientQueueActiveWallMs"),
      },
    },
    summary: [...new Set(outcomes.map((outcome) => outcome.operation))]
      .sort()
      .map((operation) => {
        const results = outcomes.filter(
          (outcome) => outcome.operation === operation,
        );
        const successful = results.filter((result) => result.ok);
        const times = successful.flatMap((result) =>
          result.settledMs === null ? [] : [result.settledMs],
        );
        return {
          operation,
          attempted: results.length,
          successful: successful.length,
          operationFailures: results.filter(
            (result) => result.errorKind === "operation",
          ).length,
          batchFailures: results.filter(
            (result) => result.errorKind === "batch",
          ).length,
          missingResults: results.filter(
            (result) => result.errorKind === "missing",
          ).length,
          successfulSettledMedianMs: percentile(times, 0.5),
          successfulSettledP95Ms: percentile(times, 0.95),
        };
      }),
  };
}

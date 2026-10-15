/** Authenticated read measurements; artifacts contain timings, never record bodies or credentials. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    output: { type: "string" },
    "raw-output": { type: "string" },
    entities: { type: "string", default: "product,recipe,planting,plant" },
    samples: { type: "string", default: "30" },
    input: { type: "string" },
    mode: { type: "string", default: "progressive" },
    concurrent: { type: "boolean", default: false },
    "first-invocation": { type: "boolean", default: false },
    caldav: { type: "boolean", default: false },
  },
});
if (!values.origin || !values.output)
  throw new Error("Provide --origin and --output");
const origin = new URL(values.origin);
if (
  origin.protocol !== "https:" &&
  origin.hostname !== "localhost" &&
  origin.hostname !== "127.0.0.1"
)
  throw new Error("Remote authentication requires HTTPS");
const samples = z.coerce.number().int().min(1).max(1000).parse(values.samples);
const mode = z.enum(["progressive", "complete"]).parse(values.mode);
const auth = process.env.CUBBY_READ_AUTHORIZATION;
const cookie = process.env.CUBBY_READ_COOKIE;
const apiKey = process.env.CUBBY_READ_API_KEY;
if (!auth && !cookie && !apiKey)
  throw new Error(
    "Set CUBBY_READ_AUTHORIZATION, CUBBY_READ_COOKIE or CUBBY_READ_API_KEY",
  );
const authHeaders = new Headers();
if (auth) authHeaders.set("authorization", auth);
if (apiKey) authHeaders.set("x-api-key", apiKey);
if (cookie) authHeaders.set("cookie", cookie);
authHeaders.set("origin", origin.origin);
const readInputSchema = z.record(z.string(), z.unknown());
type ReadInput = z.output<typeof readInputSchema>;
const input = values.input
  ? readInputSchema.parse(JSON.parse(await readFile(values.input, "utf8")))
  : { filters: {}, pagination: { pageIndex: 0, pageSize: 25 } };
const { resources: _resourcePaths, ...readInput } = input;
const fingerprint = createHash("sha256")
  .update(JSON.stringify(readInput))
  .digest("hex");
const entities = values.entities.split(",").filter(Boolean);
const rowSchema = z.object({ id: z.string() }).passthrough();
const baseSchema = z.object({
  data: z.array(rowSchema),
  groups: z.array(z.object({ id: z.string() })),
});
const patchSchema = z.object({
  groups: z.array(z.object({ state: z.enum(["ready", "error"]) })),
});
const requests: {
  version: string | null;
  requestId: string | null;
  firstResponseMs: number;
  elapsedMs: number;
  responseBodyBytes: number;
  sqlCount: number | null;
  acquisitionMs: number | null;
  cpuMs: number | null;
}[] = [];
async function request(path: string, body?: ReadInput, method = "POST") {
  const started = performance.now();
  const headers = new Headers(authHeaders);
  if (body !== undefined) headers.set("content-type", "application/json");
  const options: RequestInit = {
    method,
    headers,

    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(new URL(path, origin), options);
  const firstResponseMs = performance.now() - started;
  if (!response.ok)
    throw new Error(
      `Read failed: ${method} ${path.split("?")[0]} status ${response.status}`,
    );
  const responseBody = await response.arrayBuffer();
  const result =
    method === "OPTIONS" || method === "PROPFIND"
      ? null
      : JSON.parse(new TextDecoder().decode(responseBody));
  const measurement = {
    version: response.headers.get("x-cubby-worker-version"),
    requestId: response.headers.get("x-request-id"),
    firstResponseMs,
    elapsedMs: performance.now() - started,
    responseBodyBytes: responseBody.byteLength,
    sqlCount: null,
    acquisitionMs: null,
    cpuMs: null,
  };
  return { result, measurement };
}
const observations: {
  entity: string;
  sample: number;
  usableMs: number;
  completeMs: number;
  rows: number;
  requests: typeof requests;
}[] = [];
async function list(entity: string, sample: number) {
  const started = performance.now();
  const measurements: typeof requests = [];
  const read = async (path: string, body?: ReadInput, method = "POST") => {
    const value = await request(path, body, method);
    measurements.push(value.measurement);
    return value.result;
  };
  if (mode === "complete") {
    // The existing resource path is supplied by the caller; no singular/plural inference.
    const resource = z
      .object({ resources: z.record(z.string(), z.string()) })
      .parse(input).resources[entity];
    if (!resource) throw new Error(`Missing resources path for ${entity}`);
    const rows = z
      .object({ items: z.array(rowSchema) })
      .parse(await read(resource, undefined, "GET"));
    const elapsed = performance.now() - started;
    observations.push({
      entity,
      sample,
      usableMs: elapsed,
      completeMs: elapsed,
      rows: rows.items.length,
      requests: measurements,
    });
    return;
  }
  const base = baseSchema.parse(
    await read("/api/v1/entity/listBase", { entity, ...readInput }),
  );
  const usableMs = performance.now() - started;
  const enrichment =
    base.groups.length && base.data.length
      ? read("/api/v1/entity/listEnrichment", {
          entity,
          ids: base.data.map((row) => row.id),
          groups: base.groups.map((group) => group.id),
        }).then((result) => {
          if (
            patchSchema
              .parse(result)
              .groups.some((group) => group.state !== "ready")
          )
            throw new Error(`Enrichment failed for ${entity}`);
        })
      : Promise.resolve();
  await Promise.all([
    enrichment,
    read("/api/v1/entity/listSummary", { entity, ...readInput }),
  ]);
  observations.push({
    entity,
    sample,
    usableMs,
    completeMs: performance.now() - started,
    rows: base.data.length,
    requests: measurements,
  });
}
if (!values["first-invocation"]) {
  for (const entity of entities) await list(entity, -1);
  observations.length = 0;
}
// This label requires a freshly isolated deployment supplied by the operator. It never infers cold start.
for (let sample = 0; sample < samples; sample++) {
  if (values.concurrent)
    await Promise.all(entities.map((entity) => list(entity, sample)));
  else for (const entity of entities) await list(entity, sample);
}
if (values.caldav)
  for (let sample = 0; sample < samples; sample++)
    for (const method of ["OPTIONS", "PROPFIND"]) {
      const started = performance.now();
      const { measurement } = await request(
        "/api/caldav/calendars/me/completed-tasks/",
        undefined,
        method,
      );
      const elapsed = performance.now() - started;
      observations.push({
        entity: `caldav.${method.toLowerCase()}`,
        sample,
        usableMs: elapsed,
        completeMs: elapsed,
        rows: 0,
        requests: [measurement],
      });
    }
const percentile = (numbers: number[], quantile: number) =>
  [...numbers].sort((a, b) => a - b)[Math.ceil(numbers.length * quantile) - 1];
const summary = [...new Set(observations.map((row) => row.entity))].map(
  (entity) => {
    const rows = observations.filter((row) => row.entity === entity);
    return {
      entity,
      samples: rows.length,
      usableMedianMs: percentile(
        rows.map((row) => row.usableMs),
        0.5,
      ),
      usableP95Ms: percentile(
        rows.map((row) => row.usableMs),
        0.95,
      ),
      completeMedianMs: percentile(
        rows.map((row) => row.completeMs),
        0.5,
      ),
      completeP95Ms: percentile(
        rows.map((row) => row.completeMs),
        0.95,
      ),
      responseBodyMedianBytes: percentile(
        rows.map((row) =>
          row.requests.reduce(
            (bytes, request) => bytes + request.responseBodyBytes,
            0,
          ),
        ),
        0.5,
      ),
    };
  },
);
const artifact = {
  schema: 2,
  recordedAt: new Date().toISOString(),
  authenticationMode: apiKey
    ? "api-key"
    : auth
      ? "authorization"
      : "session-cookie",
  mode,
  concurrent: values.concurrent,
  invocation: values["first-invocation"]
    ? "operator-isolated-first"
    : "warm-sequence",
  filterFingerprint: fingerprint,
  pagination: z
    .object({
      pageIndex: z.number().int().nonnegative(),
      pageSize: z.number().int().positive(),
    })
    .optional()
    .parse(readInput.pagination),
  filterFields: Object.keys(readInputSchema.parse(readInput.filters ?? {})),
  versions: [
    ...new Set(
      observations.flatMap((row) =>
        row.requests.flatMap((request) =>
          request.version ? [request.version] : [],
        ),
      ),
    ),
  ],
  summary,
  limits: [
    "SQL, acquisition and CPU require matching sampled trace evidence; null means unavailable.",
    mode === "complete"
      ? "Usable and complete time both measure decoded complete resource rows; no early core-row response exists in this mode."
      : "Usable time measures decoded core rows; browser paint is measured by browser journeys.",
    "Response-body bytes are decoded fetch-body bytes, excluding headers and transport compression.",
    "Only aggregate measurements are published; request correlation identifiers remain in private measurement output.",
  ],
};
await writeFile(values.output, JSON.stringify(artifact, null, 2), {
  mode: 0o600,
});
if (values["raw-output"])
  await writeFile(
    values["raw-output"],
    JSON.stringify({ ...artifact, observations }, null, 2),
    { mode: 0o600 },
  );

console.log(JSON.stringify(summary, null, 2));

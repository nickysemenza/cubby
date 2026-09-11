import { describe, expect, it } from "vitest";

import document from "~/lib/generated/http-openapi.gen.json";

interface SchemaObject {
  $ref?: string;
  properties?: Record<string, { enum?: unknown[] }>;
}
type Responses = Record<
  string,
  { content?: Record<string, { schema?: SchemaObject }> } | undefined
>;
type Operation = { responses?: Responses };

// SAFETY: the generated document is emitted by generate-http-openapi.ts from
// the contract; only the `$ref`/`properties.ok.enum` facets asserted below
// are read, and every access is optional-chained.
const schemas = document.components.schemas as Record<string, SchemaObject>;
// SAFETY: same document; operations are read only for their responses.
const paths = document.paths as Record<string, Record<string, Operation>>;

function resolveRef(ref: string) {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) throw new Error(`Unexpected $ref shape: ${ref}`);
  const name = ref.slice(prefix.length);
  const schema = schemas[name];
  if (!schema) throw new Error(`Unresolved component ${name}`);
  return { name, schema };
}

function responseSchemaRef(response: Responses[string]): string | undefined {
  return response?.content?.["application/json"]?.schema?.$ref;
}

function isFailureEnvelope(schema: SchemaObject): boolean {
  const ok = schema.properties?.ok?.enum;
  return Array.isArray(ok) && ok.length === 1 && ok[0] === false;
}

// Regression for the generate-http-openapi.ts schemaTransformer fallback-id
// collision: the fallback used to omit the status code, so every response of
// one route (200 and its 400/401/403/404/409/412/500 siblings) shared a
// single component id. The shared `failure` schema (contract.ts) then
// clobbered whichever route's real success schema landed on that id in the
// emitted `components.schemas` map — see generate-http-openapi.ts for the
// fix (a fixed `ErrorEnvelope` id for `failure`, plus a status-suffixed
// fallback id for every other response).
describe("generated HTTP OpenAPI document", () => {
  it("never resolves a 200/201 response to the shared failure envelope", () => {
    const offenders: string[] = [];
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const responses = operation.responses ?? {};
        for (const status of ["200", "201"]) {
          const ref = responseSchemaRef(responses[status]);
          if (!ref) continue;
          const { name, schema } = resolveRef(ref);
          if (isFailureEnvelope(schema))
            offenders.push(`${method.toUpperCase()} ${path} -> ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("recovers agent.ask's real success schema", () => {
    const ref = responseSchemaRef(
      paths["/api/v1/agent/ask"]?.post?.responses?.["200"],
    );
    if (!ref) throw new Error("agent.ask 200 response has no $ref");
    const { schema } = resolveRef(ref);
    expect(schema.properties?.ok?.enum).toEqual([true]);
    expect(schema.properties).toHaveProperty("data");
  });

  it("routes every error response through one ErrorEnvelope component", () => {
    const errorEnvelope = schemas.ErrorEnvelope;
    expect(errorEnvelope).toBeDefined();
    expect(errorEnvelope?.properties?.ok?.enum).toEqual([false]);

    let errorResponseCount = 0;
    for (const methods of Object.values(paths)) {
      for (const operation of Object.values(methods)) {
        const responses = operation.responses ?? {};
        for (const [status, response] of Object.entries(responses)) {
          if (status === "200" || status === "201") continue;
          const ref = responseSchemaRef(response);
          if (!ref) continue;
          errorResponseCount += 1;
          expect(resolveRef(ref).name).toBe("ErrorEnvelope");
        }
      }
    }
    expect(errorResponseCount).toBeGreaterThan(0);
  });
});

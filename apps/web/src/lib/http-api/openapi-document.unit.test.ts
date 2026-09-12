import { describe, expect, it } from "vitest";

import document from "~/lib/generated/http-openapi.gen.json";

interface SchemaObject {
  $ref?: string;
  required?: string[];
  enum?: unknown[];
  properties?: Record<string, { $ref?: string; enum?: unknown[] }>;
}
type Responses = Record<
  string,
  { content?: Record<string, { schema?: SchemaObject }> } | undefined
>;
type Operation = { responses?: Responses };

// SAFETY: the generated document is emitted by generate-http-openapi.ts from
// the contract; only the `$ref`/`required`/`properties` facets asserted below
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

/**
 * The old `{ ok: true, data }` envelope, as distinct from a domain output
 * that happens to carry a boolean `ok` (a cancel or dismiss result).
 */
function isSuccessEnvelope(schema: SchemaObject): boolean {
  const ok = schema.properties?.ok;
  if (!ok || !schema.properties?.data) return false;
  const values =
    ok.$ref === undefined ? ok.enum : resolveRef(ok.$ref).schema.enum;
  return Array.isArray(values) && values.length === 1 && values[0] === true;
}

describe("generated HTTP OpenAPI document", () => {
  it("returns every success body without an envelope", () => {
    const offenders: string[] = [];
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const status of ["200", "201"]) {
          const ref = responseSchemaRef(operation.responses?.[status]);
          if (!ref) continue;
          const { name, schema } = resolveRef(ref);
          if (isSuccessEnvelope(schema) || name === "ApiError")
            offenders.push(`${method.toUpperCase()} ${path} -> ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("routes every error response through one ApiError component", () => {
    const apiError = schemas.ApiError;
    expect(apiError).toBeDefined();
    expect(apiError?.required).toEqual(
      expect.arrayContaining(["code", "message"]),
    );
    expect(apiError?.properties).not.toHaveProperty("ok");
    expect(schemas).not.toHaveProperty("ErrorEnvelope");

    let errorResponseCount = 0;
    for (const methods of Object.values(paths)) {
      for (const operation of Object.values(methods)) {
        for (const [status, response] of Object.entries(
          operation.responses ?? {},
        )) {
          if (status === "200" || status === "201") continue;
          const ref = responseSchemaRef(response);
          if (!ref) continue;
          errorResponseCount += 1;
          expect(resolveRef(ref).name).toBe("ApiError");
        }
      }
    }
    expect(errorResponseCount).toBeGreaterThan(0);
  });
});

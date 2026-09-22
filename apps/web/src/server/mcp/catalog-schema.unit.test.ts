import { PUBLIC_SHORTCODE_PREFIXES } from "@cubby/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { type JSONType, z } from "zod";

import { withErrorReporting } from "~/server/errors/report-error";

import { callMcpTool } from "./mcp-test-utils";
import { McpOperationContext } from "./operation-context";
import { listMcpToolCatalog } from "./server";
import { registerMcpTool, stripMockFromJsonSchema } from "./tools/_shared";

type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

interface IdField {
  path: string;
  node: JSONType;
}

function isJsonObject(value: JSONType): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isString(value: JSONType): value is string {
  return typeof value === "string";
}

function parseJson<T>(value: T): JSONType {
  return z.json().parse(value);
}

function parseJsonObject<T>(value: T): JsonObject {
  const parsed = parseJson(value);
  if (!isJsonObject(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

function jsonHasMock(value: JSONType): boolean {
  if (Array.isArray(value)) return value.some(jsonHasMock);
  if (!isJsonObject(value)) return false;
  return "mock" in value || Object.values(value).some(jsonHasMock);
}

function schemaHasMock<T>(value: T): boolean {
  const parsed = z.json().safeParse(value);
  return parsed.success && jsonHasMock(parsed.data);
}

function stringSchemas(node: JSONType): JsonObject[] {
  if (Array.isArray(node)) return node.flatMap(stringSchemas);
  if (!isJsonObject(node)) return [];
  // zod 4.5 emits nullable strings as `type: ["string", "null"]` rather than
  // an `anyOf` branch; both spellings must stay visible to the id-field guard.
  if (
    node.type === "string" ||
    (Array.isArray(node.type) && node.type.includes("string"))
  ) {
    return [node];
  }
  if (node.type === "array" && node.items !== undefined) {
    return stringSchemas(node.items);
  }
  return [node.anyOf, node.oneOf, node.allOf].flatMap((branches) =>
    branches === undefined ? [] : stringSchemas(branches),
  );
}

function collectIdFields(
  schema: JSONType,
  path: string,
  out: IdField[],
  definitions: JsonObject,
  stack = new Set<string>(),
): void {
  if (!isJsonObject(schema)) return;
  if (schema.$ref !== undefined && isString(schema.$ref)) {
    const name = schema.$ref.split("/").at(-1);
    if (!name || stack.has(name) || !definitions[name]) return;
    collectIdFields(
      definitions[name],
      path,
      out,
      definitions,
      new Set([...stack, name]),
    );
    return;
  }
  if (schema.properties && isJsonObject(schema.properties)) {
    // Purchase-agent execution ids address the run ledger itself; they are
    // opaque idempotency keys, not Cubby entity references/shortcodes.
    const entityProperties = Object.entries(schema.properties).filter(
      ([key]) => key !== "_runExecution",
    );
    for (const [key, value] of entityProperties) {
      const next = path ? `${path}.${key}` : key;
      const strings = stringSchemas(value);
      if (
        (key === "id" || key === "ids" || /Ids?$/u.test(key)) &&
        strings.length > 0
      ) {
        out.push({ path: next, node: value });
      }
      collectIdFields(value, next, out, definitions, stack);
    }
  }
  if (schema.items)
    collectIdFields(schema.items, `${path}[]`, out, definitions, stack);
  for (const branches of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (Array.isArray(branches)) {
      for (const branch of branches)
        collectIdFields(branch, path, out, definitions, stack);
    }
  }
}

function schemaProperties<T>(value: T): JsonObject | undefined {
  const parsed = z.json().safeParse(value);
  if (!parsed.success || !isJsonObject(parsed.data)) return undefined;
  return parsed.data.properties && isJsonObject(parsed.data.properties)
    ? parsed.data.properties
    : undefined;
}

function concreteOutputSchema(value: JSONType): boolean {
  if (!isJsonObject(value)) return false;
  const definitions = value.$defs ?? value.definitions ?? {};
  if (!isJsonObject(definitions)) return false;
  const visit = (node: JSONType, seen = new Set<string>()): boolean => {
    if (!isJsonObject(node)) return false;
    if (node.$ref !== undefined && isString(node.$ref)) {
      const name = node.$ref.split("/").at(-1);
      if (!name || seen.has(name) || !definitions[name]) return false;
      return visit(definitions[name], new Set([...seen, name]));
    }
    if (node.properties && isJsonObject(node.properties))
      return Object.keys(node.properties).length > 0;
    const alternatives = node.anyOf ?? node.oneOf;
    return (
      Array.isArray(alternatives) &&
      alternatives.length > 0 &&
      alternatives.every((branch) => visit(branch, seen))
    );
  };
  return visit(value);
}

describe("MCP catalog schemas", () => {
  it("requires every output union branch to declare concrete fields", () => {
    const concrete = {
      type: "object",
      properties: { item: { type: "string" } },
    };
    expect(concreteOutputSchema({ anyOf: [concrete, concrete] })).toBe(true);
    expect(
      concreteOutputSchema({
        anyOf: [concrete, { type: "object", additionalProperties: true }],
      }),
    ).toBe(false);
    expect(concreteOutputSchema({ type: "object", properties: {} })).toBe(
      false,
    );
  });
  it("removes fixture-only mock keys recursively", () => {
    const stripped = stripMockFromJsonSchema({
      type: "object",
      properties: {
        name: { type: "string", mock: "food.ingredient" },
        nested: { type: "object", properties: { id: { mock: "uuid" } } },
      },
    });

    expect(stripped).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        nested: { type: "object", properties: { id: {} } },
      },
    });
  });

  it("keeps non-object output validation while making it SDK-safe", async () => {
    const output = z.union([
      z.object({ total: z.number() }),
      z.object({ items: z.array(z.string()) }),
    ]);
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerMcpTool(server, {
      name: "union_out",
      description: "returns a union",
      inputSchema: z.object({}),
      outputSchema: output,
      annotations: { readOnlyHint: true },
      handler: async () => ({ total: 3 }),
    });

    const result = await callMcpTool(server, "union_out", {}, {});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ total: 3 });
  });

  it("keeps legacy refusal codes in error metadata outside success-only structured content", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const capture = vi.fn(() => "unexpected-capture");
    registerMcpTool(server, {
      name: "legacy_refusal",
      description: "Refuses invalid input",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true },
      handler: async () => {
        throw Object.assign(
          new Error("Invalid identifier", {
            cause: { reason: "INVALID_INPUT" },
          }),
          { code: "BAD_REQUEST" },
        );
      },
    });
    const result = await withErrorReporting(
      () => callMcpTool(server, "legacy_refusal", {}, {}),
      undefined,
      capture,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta).toMatchObject({
      "cubby/error": {
        code: "BAD_REQUEST",
        reason: "INVALID_INPUT",
        message: "Invalid identifier",
        diagnostics: { operation: "legacy_refusal", stage: "run" },
      },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("marks calendar state dirty only after a successful mutating tool", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const markCalendarDirty = vi.fn();
    registerMcpTool(
      server,
      {
        name: "calendar_affecting_write",
        description: "writes",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        annotations: { readOnlyHint: false },
        handler: async () => ({ ok: true }),
      },
      { markCalendarDirty },
    );
    await callMcpTool(server, "calendar_affecting_write", {}, {});
    expect(markCalendarDirty).toHaveBeenCalledWith(
      "mcp.calendar_affecting_write",
    );

    const readServer = new McpServer({ name: "test", version: "1.0.0" });
    registerMcpTool(
      readServer,
      {
        name: "calendar_read",
        description: "reads",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        annotations: { readOnlyHint: true },
        handler: async () => ({ ok: true }),
      },
      { markCalendarDirty },
    );
    await callMcpTool(readServer, "calendar_read", {}, {});
    expect(markCalendarDirty).toHaveBeenCalledTimes(1);

    const failingServer = new McpServer({ name: "test", version: "1.0.0" });
    registerMcpTool(
      failingServer,
      {
        name: "calendar_failed_write",
        description: "fails before writing",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        annotations: { readOnlyHint: false },
        handler: async () => {
          throw new Error("write failed");
        },
      },
      { markCalendarDirty },
    );
    await callMcpTool(failingServer, "calendar_failed_write", {}, {});
    expect(markCalendarDirty).toHaveBeenCalledTimes(1);
  });

  it("records a possible write when output validation fails after the handler", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const recordDatabaseWrite = vi.fn(async () => {});
    registerMcpTool(
      server,
      {
        name: "write_with_invalid_output",
        description: "writes before returning an invalid response",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        annotations: { readOnlyHint: false },
        handler: async () =>
          fromAny<{ ok: boolean }, { ok: string }>({ ok: "invalid" }),
      },
      { markCalendarDirty: vi.fn(), recordDatabaseWrite },
    );

    const result = await callMcpTool(
      server,
      "write_with_invalid_output",
      {},
      {},
    );

    expect(result.isError).toBe(true);
    expect(recordDatabaseWrite).toHaveBeenCalledWith(
      "mcp.write_with_invalid_output",
    );
  });

  it("resolves shared freshness separately for each tool execution", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const operationContext = new McpOperationContext(fromAny({}));
    const prepare = vi
      .spyOn(operationContext, "prepare")
      .mockResolvedValue(fromAny({ caller: {}, entityKernel: {} }));
    registerMcpTool(server, {
      name: "freshness_scoped_read",
      description: "reads",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true },
      handler: async () => ({ ok: true }),
    });

    await callMcpTool(
      server,
      "freshness_scoped_read",
      {},
      {},
      {
        operationContext,
      },
    );
    await callMcpTool(
      server,
      "freshness_scoped_read",
      {},
      {},
      {
        operationContext,
      },
    );

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenNthCalledWith(1, "context");
    expect(prepare).toHaveBeenNthCalledWith(2, "context");
  });

  it("publishes concrete, mock-free input and output schemas for the live catalog", async () => {
    const { tools } = await listMcpToolCatalog();
    const noArgumentInputs = new Set([
      "list_cookbooks",
      "get_recipe_tags",
      "list_actionable_tasks",
      "get_task_summary",
    ]);
    const looseOutputs = new Set(["list_problems"]);
    const emptyProperties = <TSchema>(schema: TSchema) => {
      const properties = schemaProperties(schema);
      return properties !== undefined && Object.keys(properties).length === 0;
    };

    expect(tools.length).toBeGreaterThan(50);
    expect(
      tools.filter((tool) => !tool.outputSchema).map((tool) => tool.name),
    ).toEqual([]);
    expect(
      tools
        .filter(
          (tool) =>
            schemaHasMock(tool.inputSchema) || schemaHasMock(tool.outputSchema),
        )
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(
      tools
        .filter(
          (tool) =>
            !noArgumentInputs.has(tool.name) &&
            (emptyProperties(tool.inputSchema) ||
              tool.inputSchema === undefined ||
              schemaProperties(tool.inputSchema) === undefined),
        )
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(
      tools
        .filter(
          (tool) =>
            !looseOutputs.has(tool.name) &&
            !concreteOutputSchema(parseJson(tool.outputSchema)),
        )
        .map((tool) => tool.name),
    ).toEqual([]);
  });

  it("keeps public entity-id fields self-describing in the published schemas", async () => {
    const uuidExceptions = new Set([
      "entity.command.ids",
      "entity.command.data.externalIds[].id",
      "entity.command.data.sections[].id",
      "entity.command.data.sections[].ingredients[].id",
      "entity.command.data.sections[].instructions[].id",
      "entity.command.data.unitMappings[].id",
      // entity_batch items are the same create/update commands as `entity`,
      // so they carry the same child-row ids (the ones an update edits in place).
      "entity_batch.items[].data.externalIds[].id",
      "entity_batch.items[].data.sections[].id",
      "entity_batch.items[].data.sections[].ingredients[].id",
      "entity_batch.items[].data.sections[].instructions[].id",
      "entity_batch.items[].data.unitMappings[].id",
      "update_meal_recipe.id",
      "remove_meal_recipe.id",
      "save_meal_recipe_preparation.mealRecipeId",
      "update_statement_rows.selector.externalIds",
      "update_statement_rows.data.supersededByExternalId",
      "delete_statement_rows.selector.externalIds",
      // Stable source/workflow identifiers are opaque import evidence keys,
      // not Cubby entity UUIDs or public shortcodes.
      "prepare_purchase_import.orders[].stableOrderId",
      "prepare_purchase_import.orders[].itemOperationId",
      "prepare_purchase_import.orders[].lineIds",
      "commit_purchase_import.prepareOperationId",
      "commit_purchase_import.resolutions[].stableOrderId",
      "commit_purchase_import.resolutions[].stableLineId",
      "validate_purchase_import.prepareOperationId",
      "validate_purchase_import.resolutions[].stableOrderId",
      "validate_purchase_import.resolutions[].stableLineId",
      // Run-scoped evidence ids address immutable operational captures, not
      // public Cubby entities.
      "commit_product_enrichment.changes.identifiers[].evidenceId",
      "commit_product_enrichment.changes.image.evidenceId",
    ]);
    const freeTextIds = new Set([
      "orderId",
      "externalId",
      "expectedExternalId",
      "externalAccountId",
      "providerId",
      // A Device's `installationId` is the native app's own install UUID, not
      // a Cubby shortcode.
      "installationId",
    ]);
    const violations: string[] = [];
    const stillExceptional = new Set<string>();
    for (const tool of (await listMcpToolCatalog()).tools) {
      const schema = parseJsonObject(tool.inputSchema);
      const definitionsCandidate = schema.$defs ?? schema.definitions;
      const definitions =
        definitionsCandidate && isJsonObject(definitionsCandidate)
          ? definitionsCandidate
          : {};
      const fields: IdField[] = [];
      collectIdFields(schema, "", fields, definitions);
      for (const { path, node } of fields) {
        const key = `${tool.name}.${path}`;
        const leaf = path.split(".").at(-1)?.replaceAll("[]", "") ?? "";
        if (freeTextIds.has(leaf)) continue;
        const missingPattern = stringSchemas(node).some((stringSchema) => {
          const pattern = stringSchema.pattern;
          return (
            pattern === undefined ||
            !isString(pattern) ||
            !PUBLIC_SHORTCODE_PREFIXES.some((prefix) =>
              pattern.includes(prefix),
            )
          );
        });
        if (uuidExceptions.has(key)) {
          if (missingPattern) stillExceptional.add(key);
        } else if (missingPattern) {
          violations.push(key);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(
      [...uuidExceptions].filter((key) => !stillExceptional.has(key)).sort(),
    ).toEqual([]);
  });
});

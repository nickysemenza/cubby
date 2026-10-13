import { PUBLIC_SHORTCODE_PREFIXES } from "@cubby/shared";
import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { McpServer } from "@modelcontextprotocol/server";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { type JSONType, z } from "zod";

import { withErrorReporting } from "~/server/errors/report-error";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";

import { callMcpTool, registerTestTool } from "./mcp-test-utils";
import { McpOperationContext } from "./operation-context";
import { listMcpToolCatalog } from "./server";
import { mergeActionInputSchemas } from "./tools/action-schema";
import {
  safeToJsonSchema,
  stripMockFromJsonSchema,
} from "./tools/tool-json-schema";

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

function stringSchemas(
  node: JSONType,
  definitions: JsonObject,
  seen = new Set<string>(),
): JsonObject[] {
  if (Array.isArray(node))
    return node.flatMap((entry) => stringSchemas(entry, definitions, seen));
  if (!isJsonObject(node)) return [];
  if (node.$ref !== undefined && isString(node.$ref)) {
    const name = node.$ref.split("/").at(-1);
    if (!name || definitions[name] === undefined)
      throw new Error(`Dangling input schema reference: ${node.$ref}`);
    if (seen.has(name)) return [];
    return stringSchemas(
      definitions[name],
      definitions,
      new Set([...seen, name]),
    );
  }
  // zod 4.5 emits nullable strings as `type: ["string", "null"]` rather than
  // an `anyOf` branch; both spellings must stay visible to the id-field guard.
  if (
    node.type === "string" ||
    (Array.isArray(node.type) && node.type.includes("string"))
  ) {
    return [node];
  }
  if (node.type === "array" && node.items !== undefined) {
    return stringSchemas(node.items, definitions, seen);
  }
  return [node.anyOf, node.oneOf, node.allOf].flatMap((branches) =>
    branches === undefined ? [] : stringSchemas(branches, definitions, seen),
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
      const strings = stringSchemas(value, definitions);
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
    if (Array.isArray(node.allOf))
      return node.allOf.some((branch) => visit(branch, seen));
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
  it("keeps repeated constrained workflow fields compact without weakening accepted inputs", () => {
    const field = {
      type: "string",
      minLength: 3,
      maxLength: 40,
      description:
        "Stable evidence key shared by each input field in the workflow.",
    };
    const schema = mergeActionInputSchemas([
      {
        name: "inspect",
        description: "Inspect evidence",
        schema: {
          type: "object",
          properties: {
            first: field,
            second: field,
            third: field,
            fourth: field,
          },
        },
      },
    ]);
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      schema,
    );
    expect(
      validate({
        action: "inspect",
        first: "valid",
        second: "valid",
        third: "valid",
        fourth: "valid",
      }),
    ).toBe(true);
    expect(validate({ action: "inspect", first: "x" })).toBe(false);
    expect(validate({ action: "inspect", fourth: "x".repeat(41) })).toBe(false);
    expect(JSON.stringify(schema).length).toBeLessThan(650);
  });

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
    const intersection: JsonObject = {
      allOf: [
        { $ref: "#/definitions/item" },
        { type: "object", required: ["item"] },
      ],
      definitions: { item: concrete },
    };
    expect(concreteOutputSchema(intersection)).toBe(true);
    expect(
      concreteOutputSchema({ anyOf: [intersection, { type: "object" }] }),
    ).toBe(false);
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
    registerTestTool(server, {
      name: "union_out",
      kind: "query",
      input: z.object({}),
      output,
      run: async () => ({ total: 3 }),
    });

    const result = await callMcpTool(
      server,
      "union_out",
      { action: "run" },
      {},
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ total: 3 });
  });

  it("keeps legacy refusal codes in error metadata outside success-only structured content", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const capture = vi.fn(() => "unexpected-capture");
    registerTestTool(server, {
      name: "legacy_refusal",
      kind: "query",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: async () => {
        throw Object.assign(
          new Error("Invalid identifier", {
            cause: { reason: "INVALID_INPUT" },
          }),
          { code: "BAD_REQUEST" },
        );
      },
    });
    const result = await withErrorReporting(
      () => callMcpTool(server, "legacy_refusal", { action: "run" }, {}),
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
        diagnostics: { operation: "legacy_refusal.run", stage: "run" },
      },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("marks calendar state dirty only after a successful mutating tool", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const markCalendarDirty = vi.fn();
    registerTestTool(
      server,
      {
        name: "calendar_affecting_write",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => ({ ok: true }),
      },
      { markCalendarDirty },
    );
    await callMcpTool(
      server,
      "calendar_affecting_write",
      { action: "run" },
      {},
    );
    expect(markCalendarDirty).toHaveBeenCalledWith(
      "mcp.calendar_affecting_write.run",
    );

    const readServer = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      readServer,
      {
        name: "calendar_read",
        kind: "query",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => ({ ok: true }),
      },
      { markCalendarDirty },
    );
    await callMcpTool(readServer, "calendar_read", { action: "run" }, {});
    expect(markCalendarDirty).toHaveBeenCalledTimes(1);

    const failingServer = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      failingServer,
      {
        name: "calendar_failed_write",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => {
          throw new Error("write failed");
        },
      },
      { markCalendarDirty },
    );
    await callMcpTool(
      failingServer,
      "calendar_failed_write",
      { action: "run" },
      {},
    );
    expect(markCalendarDirty).toHaveBeenCalledTimes(1);
  });

  it("records a possible write when output validation fails after the handler", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const recordDatabaseWrite = vi.fn(async () => {});
    registerTestTool(
      server,
      {
        name: "write_with_invalid_output",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () =>
          fromAny<{ ok: boolean }, { ok: string }>({ ok: "invalid" }),
      },
      { markCalendarDirty: vi.fn(), recordDatabaseWrite },
    );

    const result = await callMcpTool(
      server,
      "write_with_invalid_output",
      { action: "run" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(recordDatabaseWrite).toHaveBeenCalledWith(
      "mcp.write_with_invalid_output.run",
    );
  });

  it("prepares an authoritative read separately for each tool execution", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const operationContext = new McpOperationContext(fromAny({}));
    const prepare = vi
      .spyOn(operationContext, "prepare")
      .mockResolvedValue(fromAny({ requestContext: {}, entityKernel: {} }));
    registerTestTool(server, {
      name: "authoritative_scoped_read",
      kind: "query",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: async () => ({ ok: true }),
    });

    await callMcpTool(
      server,
      "authoritative_scoped_read",
      { action: "run" },
      {},
      {
        operationContext,
      },
    );
    await callMcpTool(
      server,
      "authoritative_scoped_read",
      { action: "run" },
      {},
      {
        operationContext,
      },
    );

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenNthCalledWith(1, "strong");
    expect(prepare).toHaveBeenNthCalledWith(2, "strong");
  });

  it("publishes concrete, mock-free input and output schemas for the live catalog", async () => {
    const { tools } = await listMcpToolCatalog();
    const looseOutputs = new Set(["activity"]);
    const emptyProperties = <TSchema>(schema: TSchema) => {
      const properties = schemaProperties(schema);
      return properties !== undefined && Object.keys(properties).length === 0;
    };

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
            emptyProperties(tool.inputSchema) ||
            tool.inputSchema === undefined ||
            schemaProperties(tool.inputSchema) === undefined,
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

  it("publishes valid Draft-7 schemas with resolvable references and empty merchant candidate tuples", async () => {
    const validator = new Ajv({ strict: false, validateFormats: false });
    const invalid: string[] = [];
    for (const tool of (await listMcpToolCatalog()).tools) {
      for (const field of ["inputSchema", "outputSchema"] as const) {
        if (!validator.validateSchema(tool[field] ?? {})) {
          invalid.push(`${tool.name}.${field}`);
        } else {
          validator.compile(tool[field] ?? {});
        }
      }
    }
    expect(invalid).toEqual([]);
  });

  it.each([
    { candidates: z.tuple([]), accepted: [], rejected: ["candidate"] },
    {
      candidates: z.tuple([]).rest(z.string()),
      accepted: ["candidate"],
      rejected: [1],
    },
  ])(
    "preserves empty-prefix tuple validation in advertised schemas",
    (fixture) => {
      const schema = safeToJsonSchema(
        z.object({ candidates: fixture.candidates }),
        "output",
      );
      const validator = new Ajv({ strict: false, validateFormats: false });
      const validate = validator.compile(schema);
      expect(validate({ candidates: fixture.accepted })).toBe(true);
      expect(validate({ candidates: fixture.rejected })).toBe(false);
    },
  );

  it("keeps public entity-id fields self-describing in the published schemas", async () => {
    const uuidExceptions = new Set([
      // delete/bulkUpdate take one kind's ids; the kernel checks each against
      // that kind's shortcode, since one flat `ids` serves every kind.
      "entity.ids",
      "entity.data.externalIds[].id",
      "entity.data.sections[].id",
      "entity.data.sections[].ingredients[].id",
      "entity.data.sections[].instructions[].id",
      "entity.data.unitMappings[].id",
      // entity.commands items are the same create/update commands, so they
      // carry the same child-row ids (the ones an update edits in place).
      "entity.commands[].data.externalIds[].id",
      "entity.commands[].data.sections[].id",
      "entity.commands[].data.sections[].ingredients[].id",
      "entity.commands[].data.sections[].instructions[].id",
      "entity.commands[].data.unitMappings[].id",
      // meal_recipe update/remove take the meal-recipe row id, and
      // save_preparation its mealRecipeId: the row has no shortcode.
      "meal_recipe.id",
      "meal_recipe.mealRecipeId",
      // Product resolve lines carry retailer/catalog identifiers (ASIN, SKU),
      // not Cubby entity ids.
      "entity_read.lines[].externalIds[].id",
      "recipe_import.lineId",
      "statement_rows.selector.externalIds",
      "statement_rows.data.supersededByExternalId",
      // Stable source/workflow identifiers are opaque import evidence keys,
      // not Cubby entity UUIDs or public shortcodes.
      "purchase_import.orders[].stableOrderId",
      "purchase_import.orders[].itemOperationId",
      "purchase_import.orders[].lineIds",
      "purchase_import.prepareOperationId",
      "purchase_import.resolutions[].stableOrderId",
      "purchase_import.resolutions[].stableLineId",
      // Email is addressed by its connected mailbox and Gmail message and
      // attachment ids, so a caller's own Gmail connector can correlate it.
      "imports_read.mailboxId",
      "imports_read.messageId",
      "imports_read.attachmentId",
      "mail.mailboxId",
      "mail.messageId",
      "run.mailboxId",
      "run.scope.mailboxId",
      // Field suggestions have no shortcode; their row id is the review
      // handle. `entityId` beside an `entity` kind is that
      // kind's shortcode, resolved by the handler.
      "entity.id",
      "entity.entityId",
      // suggest_fields' entityId and suggestion_queue's recordIds are
      // shortcodes of the kind `entity` names, so no single prefix pattern
      // fits.
      "entity_read.entityId",
      "entity_read.recordIds",
      "spending_classification_write.entityId",
      // run.lifecycle settles a Run's pending operation or approval by its
      // handle; commit_prepared carries the same opaque import keys as
      // purchase_import.commit; resolve_finding takes the finding row id.
      "run.operationId",
      "run.approvalId",
      "run.prepareOperationId",
      "run.resolutions[].stableOrderId",
      "run.resolutions[].stableLineId",
      "run.id",
      "entity_read.filters.mailboxId",
      // Reconciliation is addressed by its finding or accepted source order,
      // and accuracy review by its evaluation and frozen prediction: none of
      // those rows has a shortcode.
      "purchase_import.id",
      "purchase_import.sourceOrderId",
      "imports_read.evaluationId",
      "mail.evaluationId",
      "mail.predictionId",
    ]);
    const freeTextIds = new Set([
      "orderId",
      "externalId",
      "expectedExternalId",
      "externalAccountId",
      "providerId",
      // The statement provider's opaque transaction key is source evidence,
      // never a Cubby FinancialTransaction id or shortcode.
      "providerTransactionId",
      // Device.installationId (and the photo-import commit's top-level
      // `deviceId`, which is the same installation id, not a `DEV-`
      // shortcode) is the native app's own local identifier — never a
      // public Cubby entity reference.
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
        const missingPattern = stringSchemas(node, definitions).some(
          (stringSchema) => {
            const pattern = stringSchema.pattern;
            return (
              pattern === undefined ||
              !isString(pattern) ||
              !PUBLIC_SHORTCODE_PREFIXES.some((prefix) =>
                pattern.includes(prefix),
              )
            );
          },
        );
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

const readOnly = (openWorld = false) => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld,
});
const write = ({ destructive = false, openWorld = false } = {}) => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: false,
  openWorldHint: openWorld,
});

/**
 * The purchase agent resends every mounted tool's input schema on every model call, so each
 * published schema has a ceiling. Before consolidation the largest tool was
 * `entity` at 242,971 characters and the largest non-kernel tool
 * `prepare_purchase_import` at 8,616. The two entity-kernel tools carry every
 * kind's schema and get their own ceiling; every other tool stays under the
 * workflow ceiling, about twice that largest pre-consolidation workflow tool.
 */
const KERNEL_SCHEMA_BUDGET = 131_072;
const WORKFLOW_SCHEMA_BUDGET = 16_384;
const KERNEL_TOOLS = new Set(["entity", "entity_read"]);

function isObject(value: JSONType | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every `$ref` target and every `properties` map in a schema tree. */
function schemaFaults(schema: JsonObject): string[] {
  const definitions = isObject(schema.definitions) ? schema.definitions : {};
  const faults: string[] = [];
  const visit = (node: JSONType, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isObject(node)) return;
    const ref = z.string().safeParse(node.$ref).data;
    if (ref) {
      const name = ref.replace("#/definitions/", "");
      if (!definitions[name]) faults.push(`${path}: dangling ${ref}`);
    }
    if (isObject(node.properties) && "$ref" in node.properties)
      faults.push(`${path}.properties is a $ref, not a map of schemas`);
    for (const [key, value] of Object.entries(node))
      visit(value, `${path}.${key}`);
  };
  visit(schema, "");
  return faults;
}

describe("MCP catalog publication without services", () => {
  it("publishes the exact tool catalog with annotations derived from its actions", async () => {
    const { tools } = await listMcpToolCatalog();
    expect(
      Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])),
    ).toEqual({
      entity_read: readOnly(),
      entity: write({ destructive: true }),
      search: readOnly(),
      usda_food: readOnly(true),
      project_overview: readOnly(),
      tasks_overview: readOnly(),
      recipe_insights: readOnly(true),
      nutrition: readOnly(),
      finance_read: readOnly(),
      spending_classification_read: readOnly(),
      spending_classification_write: write(),
      imports_read: readOnly(true),
      mail: write(),
      activity: readOnly(),
      statement_rows: write({ destructive: true }),
      purchase_import: write(),
      expenses: write(),
      product_enrichment: write({ destructive: true }),
      upc: write(),
      photo_run: write(),
      run: write({ destructive: true, openWorld: true }),
      meal_recipe: write(),
      recipe_import: write({ openWorld: true }),
      image: write(),
      data_exception: write(),
    });
  });

  it("keeps every tool read-only-homogeneous", async () => {
    const { tools } = await listMcpToolCatalog();
    for (const tool of tools) {
      const binding = Object.entries(MCP_TOOL_BINDINGS).find(
        ([name]) => name === tool.name,
      )?.[1];
      if (!binding) throw new Error(`${tool.name} has no generated binding`);
      const kinds = new Set(
        Object.values(binding.actions).map((action) => action.kind),
      );
      expect([tool.name, [...kinds]]).toEqual([
        tool.name,
        [tool.annotations?.readOnlyHint ? "query" : "mutation"],
      ]);
    }
  });

  it("keeps each published input schema portable and under its budget", async () => {
    const { tools } = await listMcpToolCatalog();
    const oversized: string[] = [];
    for (const tool of tools) {
      const schema = z.json().parse(tool.inputSchema);
      if (!isObject(schema)) throw new Error(`${tool.name}: no object schema`);
      // Anthropic rejects anyOf/oneOf/allOf at the ROOT of input_schema.
      expect([tool.name, schema.type, "anyOf" in schema]).toEqual([
        tool.name,
        "object",
        false,
      ]);
      expect("oneOf" in schema || "allOf" in schema).toBe(false);
      expect(schema.required).toEqual(["action"]);
      expect(schemaFaults(schema)).toEqual([]);
      const size = JSON.stringify(schema).length;
      const budget = KERNEL_TOOLS.has(tool.name)
        ? KERNEL_SCHEMA_BUDGET
        : WORKFLOW_SCHEMA_BUDGET;
      if (size > budget) oversized.push(`${tool.name}: ${size} > ${budget}`);
    }
    expect(oversized).toEqual([]);
  });
});

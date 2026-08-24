import { PUBLIC_SHORTCODE_PREFIXES } from "@cubby/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callMcpTool } from "./mcp-test-utils";
import { listMcpToolCatalog } from "./server";
import { registerMcpTool, stripMockFromJsonSchema } from "./tools/_shared";

function schemaHasMock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaHasMock);
  const object = value as Record<string, unknown>;
  return "mock" in object || Object.values(object).some(schemaHasMock);
}

function stringSchemas(node: unknown): Array<Record<string, unknown>> {
  if (!node || typeof node !== "object") return [];
  const object = node as Record<string, unknown>;
  if (object.type === "string") return [object];
  if (object.type === "array") return stringSchemas(object.items);
  return [object.anyOf, object.oneOf, object.allOf]
    .filter(Array.isArray)
    .flatMap((branches) => branches.flatMap(stringSchemas));
}

function collectIdFields(
  schema: unknown,
  path: string,
  out: Array<{ path: string; node: unknown }>,
  definitions: Record<string, unknown>,
  stack = new Set<string>(),
): void {
  if (!schema || typeof schema !== "object") return;
  const object = schema as Record<string, unknown>;
  if (typeof object.$ref === "string") {
    const name = object.$ref.split("/").at(-1);
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
  if (object.properties && typeof object.properties === "object") {
    for (const [key, value] of Object.entries(
      object.properties as Record<string, unknown>,
    )) {
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
  if (object.items)
    collectIdFields(object.items, `${path}[]`, out, definitions, stack);
  for (const branches of [object.anyOf, object.oneOf, object.allOf]) {
    if (Array.isArray(branches)) {
      for (const branch of branches)
        collectIdFields(branch, path, out, definitions, stack);
    }
  }
}

describe("MCP catalog schemas", () => {
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
      outputSchema: output,
      annotations: { readOnlyHint: true },
      handler: async () => ({ total: 3 }),
    });

    const result = await callMcpTool(server, "union_out", {}, {});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ total: 3 });
  });

  it("publishes concrete, mock-free input and output schemas for the live catalog", async () => {
    const { tools } = await listMcpToolCatalog();
    const noArgumentInputs = new Set([
      "list_cookbooks",
      "get_recipe_tags",
      "list_actionable_tasks",
      "get_task_summary",
    ]);
    const looseOutputs = new Set([
      "entity",
      "list_problems",
      "get_usda_food",
      "find_usda_food",
    ]);
    const emptyProperties = (schema: unknown) => {
      const properties = (schema as { properties?: Record<string, unknown> })
        ?.properties;
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
              (tool.inputSchema as Record<string, unknown>).properties ===
                undefined),
        )
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(
      tools
        .filter(
          (tool) =>
            !looseOutputs.has(tool.name) &&
            (emptyProperties(tool.outputSchema) ||
              (tool.outputSchema as Record<string, unknown>).properties ===
                undefined),
        )
        .map((tool) => tool.name),
    ).toEqual([]);
  });

  it("keeps public entity-id fields self-describing in the published schemas", async () => {
    const uuidExceptions = new Set([
      "entity.command.id",
      "entity.command.ids",
      "entity.command.items[].id",
      "entity.command.data.externalIds[].id",
      "entity.command.data.sections[].id",
      "entity.command.data.sections[].ingredients[].id",
      "entity.command.data.sections[].instructions[].id",
      "entity.command.data.unitMappings[].id",
      "update_meal_recipe.id",
      "remove_meal_recipe.id",
      "update_statement_rows.selector.externalIds",
      "update_statement_rows.data.supersededByExternalId",
      "delete_statement_rows.selector.externalIds",
      "attach_file.uploadId",
      "attach_files.items[].uploadId",
    ]);
    const freeTextIds = new Set([
      "orderId",
      "externalId",
      "expectedExternalId",
      "externalAccountId",
      "providerId",
    ]);
    const violations: string[] = [];
    const stillExceptional = new Set<string>();
    for (const tool of (await listMcpToolCatalog()).tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      const definitions =
        (schema.$defs as Record<string, unknown> | undefined) ??
        (schema.definitions as Record<string, unknown> | undefined) ??
        {};
      const fields: Array<{ path: string; node: unknown }> = [];
      collectIdFields(schema, "", fields, definitions);
      for (const { path, node } of fields) {
        const key = `${tool.name}.${path}`;
        const leaf = path.split(".").at(-1)?.replaceAll("[]", "") ?? "";
        if (freeTextIds.has(leaf)) continue;
        const missingPattern = stringSchemas(node).some((string) => {
          const pattern = string.pattern;
          return (
            typeof pattern !== "string" ||
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

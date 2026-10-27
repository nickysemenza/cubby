import { galleryEntities } from "@cubby/schemas/entity-manifest";
import { testShortcode } from "@cubby/schemas/testing";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { type JSONType, z } from "zod";

import { toWire } from "~/lib/operation-wire";
import {
  MCP_TOOL_BINDINGS,
  MCP_TOOL_DECLARATIONS,
} from "~/server/generated/mcp-tools.gen";

import {
  describeMcpActions,
  withProgressiveDisclosure,
} from "./progressive-disclosure";
import { advertisedJsonSchema, safeToJsonSchema } from "./tool-json-schema";
import { compiledMcpTools } from "./tool-registration";

type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

function isJsonObject(value: JSONType): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

/** Every `{ format: "date" }` leaf in a JSON Schema tree, as a dotted path. */
function collectBareDateFormats(
  node: JSONType,
  path: string,
  hits: string[],
): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      collectBareDateFormats(child, `${path}[${index}]`, hits),
    );
    return;
  }
  if (!isJsonObject(node)) return;
  if (node.format === "date") hits.push(path);
  for (const [key, value] of Object.entries(node)) {
    collectBareDateFormats(value, `${path}.${key}`, hits);
  }
}

type ActionSchemas = { name: string; input: z.ZodType; output: z.ZodType };

const tools = compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOL_DECLARATIONS);

/** Paths whose `items` is an array: a tuple in draft-7 form. */
function collectTupleItems(node: JSONType, path: string, hits: string[]) {
  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      collectTupleItems(child, `${path}[${index}]`, hits),
    );
    return;
  }
  if (!isJsonObject(node)) return;
  if (Array.isArray(node.items)) hits.push(`${path}.items`);
  for (const [key, value] of Object.entries(node))
    collectTupleItems(value, `${path}.${key}`, hits);
}

const actions: readonly ActionSchemas[] = tools.flatMap((tool) =>
  [...tool.actions.values()].map((action) => ({
    name: action.name,
    input: action.input,
    output: action.output,
  })),
);

function requireAction(name: string): ActionSchemas {
  const action = actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`${name} is not a registered MCP action`);
  return action;
}

/** Walks a JSON Schema by draft-7 `properties`/`items` path segments. */
function jsonAt(node: JSONType, ...path: string[]): JSONType {
  let current = node;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      throw new Error(`Expected an object schema before "${segment}"`);
    }
    current = current[segment] ?? null;
  }
  return current;
}

describe("MCP tool JSON Schema — toWire parity", () => {
  it("describe returns the full input and output schemas for a named action", async () => {
    const nutrition = tools.find((tool) => tool.name === "nutrition");
    if (!nutrition) throw new Error("Missing nutrition tool");
    expect(nutrition.inputJsonSchema).toMatchObject({
      properties: {
        action: { enum: expect.arrayContaining(["plan_recipe", "describe"]) },
        input: { type: "object" },
      },
      required: ["action", "input"],
    });
    const described = describeMcpActions(nutrition, ["plan_recipe"]);

    expect(described.actions).toHaveLength(1);
    expect(described.actions[0]).toMatchObject({
      action: "plan_recipe",
      description: expect.any(String),
      inputSchema: { type: "object", properties: expect.any(Object) },
      outputSchema: { type: "object" },
    });
    const handler = withProgressiveDisclosure(
      async () => ({ content: [] }),
      nutrition,
    );
    const describedResult = await handler(
      { action: "describe", input: { actions: ["plan_recipe"] } },
      fromPartial({}),
    );
    expect(describedResult.isError).not.toBe(true);
    expect(describedResult.structuredContent).toMatchObject({
      actions: [
        {
          action: "plan_recipe",
          inputSchema: { type: "object", properties: expect.any(Object) },
          outputSchema: { type: "object" },
        },
      ],
    });
    const unknownResult = await handler(
      { action: "describe", input: { actions: ["missing"] } },
      fromPartial({}),
    );
    expect(unknownResult.isError).toBe(true);
    expect(unknownResult.content[0]).toMatchObject({
      text: expect.stringContaining('Unknown action "missing"'),
    });
  });

  it.each(actions.map((action) => [action.name, action] as const))(
    "%s: input and output schema pass through toWire without throwing",
    (_name, action) => {
      expect(() => toWire(action.input, "input")).not.toThrow();
      expect(() => toWire(action.output, "output")).not.toThrow();
    },
  );

  it("documents activity_read.list's nested createdAt as date-time", () => {
    const action = requireAction("activity_read.list");
    const schema = advertisedJsonSchema(action.name, action.output, "output");
    const createdAt = jsonAt(
      schema,
      "properties",
      "entries",
      "items",
      "properties",
      "createdAt",
    );
    if (!isJsonObject(createdAt)) throw new Error("Expected an object schema");
    expect(createdAt.type).toBe("string");
    expect(createdAt.format).toBe("date-time");
  });

  // Clients validate tool schemas as JSON Schema 2020-12, where `items` must
  // be one schema; a draft-7 tuple (`items: [...]`) made claude.ai reject the
  // whole `entity_read` tool ("items value must be [object, boolean]").
  it("advertises no draft-7 tuple `items` arrays in any tool schema", () => {
    const hits: string[] = [];
    for (const tool of tools) {
      collectTupleItems(tool.inputJsonSchema, `${tool.name}.input`, hits);
      collectTupleItems(
        advertisedJsonSchema(tool.name, tool.output, "output"),
        `${tool.name}.output`,
        hits,
      );
    }
    expect(hits).toEqual([]);
  });

  it("validates the aggregate entity_read schema without an oversized AJV stack frame", () => {
    const tool = tools.find((candidate) => candidate.name === "entity_read");
    if (!tool) throw new Error("Missing entity_read tool");
    const schema = advertisedJsonSchema(tool.name, tool.output, "output");
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    expect(
      validate({
        action: "list",
        entity: "location",
        items: [
          { id: testShortcode("location", "ABC1"), name: "Synthetic cupboard" },
        ],
      }).valid,
    ).toBe(true);
    expect(
      validate({ action: "list", entity: "location", items: [{ id: 123 }] })
        .valid,
    ).toBe(false);
  }, 30_000);

  it("publishes a tuple as one items schema with Zod's own length bounds", () => {
    const schema = safeToJsonSchema(
      z.object({ pair: z.tuple([z.string(), z.number().optional()]) }),
      "input",
    );
    expect(jsonAt(schema, "properties", "pair")).toMatchObject({
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
      minItems: 1,
      maxItems: 2,
    });
  });

  it("advertises no bare `format: date` anywhere in the catalog", () => {
    const hits: string[] = [];
    for (const action of actions) {
      const input = safeToJsonSchema(action.input, "input");
      const output = advertisedJsonSchema(action.name, action.output, "output");
      collectBareDateFormats(input, `${action.name}.input`, hits);
      collectBareDateFormats(output, `${action.name}.output`, hits);
    }
    expect(hits).toEqual([]);
  });

  it("advertises gallery and singular attachments with explicit replacement roles", () => {
    const attachFiles = requireAction("image.attach_file").input;
    const attachExisting = requireAction("image.attach_existing").input;
    const image = tools.find((tool) => tool.name === "image");
    if (!image) throw new Error("Missing image tool");
    const description = describeMcpActions(image, [
      "attach_file",
      "attach_existing",
    ]);

    for (const entity of galleryEntities) {
      const targetId = testShortcode(entity, "ABC1");
      expect(JSON.stringify(description)).toContain(entity);
      expect(
        attachFiles.safeParse({
          items: [{ entityId: targetId, url: "https://example.test/file.jpg" }],
        }).success,
      ).toBe(true);
      expect(
        attachExisting.safeParse({
          imageId: testShortcode("image", "IMG1"),
          targetId,
        }).success,
      ).toBe(true);
    }

    for (const [entity, role] of [
      ["vendor", "logo"],
      ["cookbook", "cover"],
    ] as const) {
      const targetId = testShortcode(entity, "ABC1");
      expect(
        attachFiles.safeParse({
          items: [
            { entityId: targetId, role, url: "https://example.test/file.jpg" },
          ],
        }).success,
      ).toBe(true);
      expect(
        attachExisting.safeParse({
          imageId: testShortcode("image", "IMG1"),
          targetId,
          role,
        }).success,
      ).toBe(true);
      expect(
        attachExisting.safeParse({
          imageId: testShortcode("image", "IMG1"),
          targetId,
          role: "attachment",
        }).success,
      ).toBe(false);
    }
    const vendorId = testShortcode("vendor", "ABC1");
    expect(
      attachFiles.safeParse({
        items: [{ entityId: vendorId, url: "https://example.test/file.jpg" }],
      }).success,
    ).toBe(false);
    expect(
      attachExisting.safeParse({
        imageId: testShortcode("image", "IMG1"),
        targetId: vendorId,
      }).success,
    ).toBe(false);
  });

  it("publishes batched upload initiation and excludes base64 attachment input", () => {
    const createUploads = requireAction("image.create_file_upload").input;
    const attachFiles = requireAction("image.attach_file").input;
    const entityId = testShortcode("product", "ABC1");
    const upload = {
      entityId,
      filename: "item.jpg",
      contentType: "image/jpeg",
      size: 123,
    };

    expect(createUploads.safeParse({ items: [upload] }).success).toBe(true);
    expect(
      createUploads.safeParse({ items: [{ ...upload, size: 0 }] }).success,
    ).toBe(false);
    expect(
      createUploads.safeParse({
        items: Array.from({ length: 51 }, () => upload),
      }).success,
    ).toBe(false);
    expect(
      attachFiles.safeParse({
        items: [{ entityId, data: "aGVsbG8=", contentType: "image/jpeg" }],
      }).success,
    ).toBe(false);
    expect(
      attachFiles.safeParse({
        items: [
          {
            entityId,
            url: "https://example.test/item.jpg",
            uploadId: testShortcode("image", "IMG1"),
          },
        ],
      }).success,
    ).toBe(false);
  });
});

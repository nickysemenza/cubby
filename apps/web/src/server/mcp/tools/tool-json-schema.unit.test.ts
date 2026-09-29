import { galleryEntities } from "@cubby/schemas/entity-manifest";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { type JSONType, z } from "zod";

import { MCP_TOOLS } from "~/contracts/mcp-tools";
import { toWire } from "~/lib/http-api/wire";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";

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

const actions: readonly ActionSchemas[] = compiledMcpTools(
  MCP_TOOL_BINDINGS,
  MCP_TOOLS,
).flatMap((tool) =>
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
  it("compiles every action of the 21 tools", () => {
    expect(
      new Set(actions.map((action) => action.name.split(".")[0])).size,
    ).toBe(21);
  });

  it.each(actions.map((action) => [action.name, action] as const))(
    "%s: input and output schema pass through toWire without throwing",
    (_name, action) => {
      expect(() => toWire(action.input, "input")).not.toThrow();
      expect(() => toWire(action.output, "output")).not.toThrow();
    },
  );

  it("documents finance_read.statement_rows' nested createdAt as date-time", () => {
    const action = requireAction("finance_read.statement_rows");
    const schema = advertisedJsonSchema(action.name, action.output, "output");
    const createdAt = jsonAt(
      schema,
      "properties",
      "data",
      "items",
      "properties",
      "createdAt",
    );
    if (!isJsonObject(createdAt)) throw new Error("Expected an object schema");
    expect(createdAt.type).toBe("string");
    expect(createdAt.format).toBe("date-time");
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

  it("advertises every gallery entity and rejects non-gallery attachment targets", () => {
    const attachFiles = requireAction("image.attach_files").input;
    const attachExisting = requireAction("image.attach_existing").input;
    const description =
      compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOLS).find(
        (tool) => tool.name === "image",
      )?.inputJsonSchema ?? {};

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
    const createUploads = requireAction("image.create_uploads").input;
    const attachFiles = requireAction("image.attach_files").input;
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

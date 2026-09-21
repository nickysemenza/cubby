import { galleryEntities } from "@cubby/schemas/entity-manifest";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { type JSONType, z } from "zod";

import { toWire } from "~/lib/http-api/wire";

import { createMcpServer } from "../server";
import {
  type DeclaredToolSchemas,
  listDeclaredToolSchemas,
} from "./tool-catalog";
import { advertisedJsonSchema } from "./tool-json-schema";

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

function requireZodType(
  schema: z.core.$ZodType | undefined,
  label: string,
): z.ZodType {
  if (!(schema instanceof z.ZodType)) {
    throw new Error(`${label}: expected a registered Zod schema`);
  }
  return schema;
}

function requireTool(
  tools: readonly DeclaredToolSchemas[],
  name: string,
): DeclaredToolSchemas {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} is not a registered MCP tool`);
  return tool;
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
  const server = createMcpServer();
  const tools = listDeclaredToolSchemas(server);

  it("registers more than 50 tools", () => {
    expect(tools.length).toBeGreaterThan(50);
  });

  it("declares an input and an output schema for every registered tool", () => {
    const incomplete = tools
      .filter((tool) => !tool.inputSchema || !tool.outputSchema)
      .map((tool) => tool.name);
    expect(incomplete).toEqual([]);
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    "%s: input and output schema pass through toWire without throwing",
    (name, tool) => {
      const input = requireZodType(tool.inputSchema, `${name} input`);
      const output = requireZodType(tool.outputSchema, `${name} output`);
      expect(() => toWire(input, "input")).not.toThrow();
      expect(() => toWire(output, "output")).not.toThrow();
    },
  );

  it("documents list_statement_rows' nested createdAt as date-time", () => {
    const tool = requireTool(tools, "list_statement_rows");
    const schema = advertisedJsonSchema(tool.name, tool.outputSchema, "output");
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
    for (const tool of tools) {
      const input = advertisedJsonSchema(tool.name, tool.inputSchema, "input");
      const output = advertisedJsonSchema(
        tool.name,
        tool.outputSchema,
        "output",
      );
      collectBareDateFormats(input, `${tool.name}.input`, hits);
      collectBareDateFormats(output, `${tool.name}.output`, hits);
    }
    expect(hits).toEqual([]);
  });

  it("advertises every gallery entity and rejects non-gallery attachment targets", () => {
    const attachFiles = requireTool(tools, "attach_files");
    const attachExisting = requireTool(tools, "attach_existing_image");
    const schemas = [attachFiles, attachExisting].map((tool) => ({
      tool,
      input: requireZodType(tool.inputSchema, `${tool.name} input`),
    }));

    for (const entity of galleryEntities) {
      const targetId = testShortcode(entity, "ABC1");
      expect(attachFiles.description ?? "").toContain(entity);
      expect(attachExisting.description ?? "").toContain(entity);
      expect(
        schemas[0]!.input.safeParse({
          items: [{ entityId: targetId, url: "https://example.test/file.jpg" }],
        }).success,
      ).toBe(true);
      expect(
        schemas[1]!.input.safeParse({
          imageId: testShortcode("image", "IMG1"),
          targetId,
        }).success,
      ).toBe(true);
    }

    const vendorId = testShortcode("vendor", "ABC1");
    expect(
      schemas[0]!.input.safeParse({
        items: [{ entityId: vendorId, url: "https://example.test/file.jpg" }],
      }).success,
    ).toBe(false);
    expect(
      schemas[1]!.input.safeParse({
        imageId: testShortcode("image", "IMG1"),
        targetId: vendorId,
      }).success,
    ).toBe(false);
  });

  it("publishes batched upload initiation and excludes base64 attachment input", () => {
    expect(tools.some((tool) => tool.name === "create_file_upload")).toBe(
      false,
    );
    expect(tools.some((tool) => tool.name === "attach_file")).toBe(false);

    const createUploads = requireZodType(
      requireTool(tools, "create_file_uploads").inputSchema,
      "create_file_uploads input",
    );
    const attachFiles = requireZodType(
      requireTool(tools, "attach_files").inputSchema,
      "attach_files input",
    );
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

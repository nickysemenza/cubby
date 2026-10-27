import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  detailEntities,
  getEntityDetailOutputSchema,
} from "./generated/entity-details.gen";
import {
  getEntityListOutputSchema,
  type ListEntity,
  listEntities,
} from "./generated/entity-lists.gen";

const schemaAt = (
  schema: z.core.$ZodType,
  path: readonly string[],
): z.core.$ZodType | undefined => {
  if (path.length === 0) return schema;
  if (schema instanceof z.ZodIntersection)
    return schemaAt(schema.def.left, path) ?? schemaAt(schema.def.right, path);
  if (!(schema instanceof z.ZodObject)) return undefined;
  const [key, ...rest] = path;
  const child = key === undefined ? undefined : schema.shape[key];
  return child ? schemaAt(child, rest) : undefined;
};

// The kernel list output is `{ items: [...row], meta }`; the row is the contract.
const listRowSchema = (entity: ListEntity): z.core.$ZodType => {
  const page = getEntityListOutputSchema(entity);
  if (!(page instanceof z.ZodObject))
    throw new Error(`${entity} list is not an object`);
  const items = page.shape.items;
  if (!(items instanceof z.ZodArray))
    throw new Error(`${entity} list has no items`);
  const row = items.element;
  return row;
};

// The list contract behind every thumbnail — web tables, native rows — is
// `fields.displayImages`, selected by the public envelope serializer. A new
// entity must carry it, even when the truthful result is an empty array.
describe("displayImages list contract", () => {
  it("every entity list schema carries the field", () => {
    for (const entity of listEntities) {
      expect
        .soft(
          schemaAt(listRowSchema(entity), ["fields", "displayImages"]) !==
            undefined,
          `${entity} list schema lacks displayImages`,
        )
        .toBe(true);
    }
  });
});

describe("entity detail media contract", () => {
  it("every entity detail schema carries display images and attachments", () => {
    for (const entity of detailEntities) {
      const schema = getEntityDetailOutputSchema(entity);
      expect
        .soft(
          schemaAt(schema, ["fields", "displayImages"]) !== undefined,
          `${entity} lacks displayImages`,
        )
        .toBe(true);
      expect
        .soft(
          schemaAt(schema, ["attachments"]) !== undefined,
          `${entity} lacks attachments`,
        )
        .toBe(true);
      expect
        .soft(
          schemaAt(schema, ["displayImages"]),
          `${entity} exposes a competing displayImages slot`,
        )
        .toBeUndefined();
      const attachments = schemaAt(schema, ["attachments"]);
      if (!(attachments instanceof z.ZodArray))
        throw new Error(`${entity} attachments must be an array`);
      expect
        .soft(
          schemaAt(attachments.element, ["fields", "url"]),
          `${entity} attachment lacks its URL envelope`,
        )
        .toBeDefined();
      for (const legacy of [
        "url",
        "fieldResolutions",
        "derived",
        "attachments",
      ])
        expect
          .soft(
            schemaAt(attachments.element, [legacy]),
            `${entity} attachment exposes ${legacy}`,
          )
          .toBeUndefined();
    }
  });
});

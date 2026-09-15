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

const hasField = (schema: z.core.$ZodType, field: string): boolean => {
  if (schema instanceof z.ZodObject) return field in schema.shape;
  if (schema instanceof z.ZodIntersection)
    return (
      hasField(schema.def.left, field) || hasField(schema.def.right, field)
    );
  return false;
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
// `displayImages`, attached server-side by `withDisplayImages`. A new
// entity must carry it, even when the truthful result is an empty array.
describe("displayImages list contract", () => {
  it("every entity list schema carries the field", () => {
    for (const entity of listEntities) {
      expect
        .soft(
          hasField(listRowSchema(entity), "displayImages"),
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
          hasField(schema, "displayImages"),
          `${entity} lacks displayImages`,
        )
        .toBe(true);
      expect
        .soft(hasField(schema, "attachments"), `${entity} lacks attachments`)
        .toBe(true);
    }
  });
});

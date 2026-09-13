import { displayImageEntities } from "@cubby/schemas/entity-manifest";
import { cookbookSummary } from "@cubby/schemas/recipe";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  getEntityListOutputSchema,
  type ListEntity,
  listEntities,
} from "./generated/entity-lists.gen";

const hasDisplayImages = (schema: z.ZodObject): boolean =>
  "displayImages" in schema.shape;

// The kernel list output is `{ items: [...row], meta }`; the row is the contract.
const listRowSchema = (entity: ListEntity): z.ZodObject => {
  const page = getEntityListOutputSchema(entity);
  if (!(page instanceof z.ZodObject))
    throw new Error(`${entity} list is not an object`);
  const items = page.shape.items;
  if (!(items instanceof z.ZodArray))
    throw new Error(`${entity} list has no items`);
  const row = items.element;
  if (!(row instanceof z.ZodObject))
    throw new Error(`${entity} list row is not an object`);
  return row;
};

const isListEntity = (entity: string): entity is ListEntity =>
  listEntities.some((candidate) => candidate === entity);

// The list contract behind every thumbnail — web tables, native rows — is
// `displayImages`, attached server-side by `withDisplayImages`. A new
// image-bearing entity (own gallery/cover or `"borrowed"`) must carry it on
// its list schema, or its rows render placeholders on every client at once.
describe("displayImages list contract", () => {
  it("every displayImages entity's list schema carries the field", () => {
    for (const entity of displayImageEntities) {
      if (!isListEntity(entity)) continue;
      expect
        .soft(
          hasDisplayImages(listRowSchema(entity)),
          `${entity} list schema lacks displayImages`,
        )
        .toBe(true);
    }
  });

  it("cookbook, listed outside the kernel, carries it too", () => {
    expect(hasDisplayImages(cookbookSummary)).toBe(true);
  });

  it("no other list schema carries it (the manifest is the roster)", () => {
    const roster = new Set<string>(displayImageEntities);
    for (const entity of listEntities) {
      if (roster.has(entity)) continue;
      expect
        .soft(
          hasDisplayImages(listRowSchema(entity)),
          `${entity} carries displayImages without declaring images in its manifest`,
        )
        .toBe(false);
    }
  });
});

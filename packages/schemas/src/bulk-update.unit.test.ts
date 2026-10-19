import { expect, it } from "vitest";
import { z } from "zod";
import {
  bulkUpdateInputSchema,
  bulkValueCollectionPatch,
} from "./entity-collection";

it("bulk collection patches preserve scalar validation and ordinary object refinements without widening normal arrays", () => {
  const normal = z
    .object({
      tokens: z.array(z.string().min(2)).optional(),
      amount: z.number().positive().optional(),
      starts: z.number().optional(),
      ends: z.number().optional(),
    })
    .refine(
      (data) =>
        data.starts === undefined ||
        data.ends === undefined ||
        data.starts <= data.ends,
      { message: "Ends before starts" },
    );
  const schema = bulkUpdateInputSchema(
    normal,
    { ...normal.shape, tokens: bulkValueCollectionPatch.optional() },
    ["tokens"],
  );
  expect(schema.safeParse({ tokens: ["shared"] }).success).toBe(false);
  expect(
    schema.safeParse({
      tokens: [{ op: "replace", key: "old", value: "shared" }],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      tokens: [
        { op: "add", key: "shared" },
        { op: "remove", key: "old" },
      ],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({ amount: -1, tokens: [{ op: "add", key: "shared" }] })
      .success,
  ).toBe(false);
  expect(schema.safeParse({ starts: 3, ends: 2 }).success).toBe(false);
  expect(schema.safeParse({ name: "shared" }).success).toBe(false);
  expect(
    normal.safeParse({ tokens: [{ op: "add", key: "shared" }] }).success,
  ).toBe(false);
  expect(normal.safeParse({ tokens: ["x"] }).success).toBe(false);
});

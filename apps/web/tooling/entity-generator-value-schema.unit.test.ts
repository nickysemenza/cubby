import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadEntityDeclarations } from "../../../scripts/generator/entities/declarations";
import {
  type EntityForPrefix,
  valueSchemaOf,
  type ValueSchemaJSON,
} from "../../../scripts/generator/entities/render/value-schema";
import { drawsFromValueSchema } from "../../../packages/schemas/src/native-coverage";

const noEntity: EntityForPrefix = () => null;
const schemaOf = (
  schema: z.ZodType,
  entityForPrefix: EntityForPrefix = noEntity,
) => valueSchemaOf(schema, "test", entityForPrefix);

/** The object fields of a schema, failing loudly on any other node. */
const fieldsOf = (schema: ValueSchemaJSON) => {
  if (!("object" in schema.node)) throw new Error("expected an object node");
  return Object.fromEntries(
    schema.node.object.fields.map((field) => [field.key, field]),
  );
};

describe("valueSchemaOf", () => {
  it("describes rows of amounts with optional hidden ids and nullable text", () => {
    const schema = schemaOf(
      z.array(
        z.object({
          a: z.object({
            value: z.number(),
            unit: z.string().min(1),
            upperValue: z.number().positive().optional(),
          }),
          b: z.object({ value: z.number(), unit: z.string().min(1) }),
          source: z.string().nullable(),
          id: z.uuid().optional(),
        }),
      ),
    );
    expect(schema.nullable).toBe(false);
    if (!("array" in schema.node)) throw new Error("expected array");
    const row = fieldsOf(schema.node.array.item);
    expect(row.a).toMatchObject({
      required: true,
      schema: { node: { amount: { upper: true } } },
    });
    expect(row.b?.schema.node).toEqual({ amount: { upper: false } });
    expect(row.source).toMatchObject({
      required: true,
      schema: { nullable: true, node: { text: { format: null } } },
    });
    expect(row.id).toMatchObject({
      required: false,
      schema: { node: { text: { format: "uuid" } } },
    });
  });

  it("treats a defaulted key as optional and labels keys for people", () => {
    const row = fieldsOf(
      schemaOf(z.object({ externalId: z.string().default("x"), url: z.url() })),
    );
    expect(row.externalId).toMatchObject({
      label: "External id",
      required: false,
    });
    expect(row.url).toMatchObject({
      required: true,
      schema: { node: { text: { format: "uri" } } },
    });
  });

  it("marks a nullable object nullable and a partial record a map over its keys", () => {
    const schema = schemaOf(
      z
        .object({
          servingGrams: z.number().positive(),
          nutrients: z.partialRecord(
            z.enum(["protein", "saturated_fat"]),
            z.number().nonnegative(),
          ),
        })
        .nullable(),
    );
    expect(schema.nullable).toBe(true);
    const fields = fieldsOf(schema);
    expect(fields.nutrients?.schema.node).toEqual({
      map: {
        keys: [
          { value: "protein", label: "Protein" },
          { value: "saturated_fat", label: "Saturated fat" },
        ],
        value: { nullable: false, node: { number: { integer: false } } },
      },
    });
  });

  it("carries a field's readFrom metadata as its readPath, and only then", () => {
    const row = fieldsOf(
      schemaOf(
        z.object({
          ingredientId: z.string().meta({ readFrom: "ingredient.id" }),
          note: z.string(),
        }),
      ),
    );
    expect(row.ingredientId?.readPath).toBe("ingredient.id");
    expect(row.note).not.toHaveProperty("readPath");
  });

  it("describes a discriminated union as a variant whose cases carry their own fields", () => {
    const schema = schemaOf(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("cash") }),
        z.object({
          kind: z.literal("bank_account"),
          accountType: z.enum(["checking", "savings"]),
          other: z.null(),
        }),
      ]),
    );
    expect(schema.node).toEqual({
      variant: {
        discriminator: "kind",
        cases: [
          { value: "cash", label: "Cash", fields: [] },
          {
            value: "bank_account",
            label: "Bank account",
            fields: [
              {
                key: "accountType",
                label: "Account type",
                required: true,
                schema: {
                  nullable: false,
                  node: {
                    enum: {
                      options: [
                        { value: "checking", label: "Checking" },
                        { value: "savings", label: "Savings" },
                      ],
                    },
                  },
                },
              },
              {
                key: "other",
                label: "Other",
                required: true,
                schema: { nullable: true, node: { constant: { value: null } } },
              },
            ],
          },
        ],
      },
    });
  });

  it("recognizes calendar days and entity shortcodes", () => {
    const row = fieldsOf(
      schemaOf(
        z.object({
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          ingredientId: z
            .string()
            .regex(/^ING-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,5}$/),
          unknownId: z.string().regex(/^ZZZ-[A-Z]{4}$/),
        }),
        (prefix) => (prefix === "ING-" ? "ingredient" : null),
      ),
    );
    expect(row.day?.schema.node).toEqual({ text: { format: "date" } });
    expect(row.ingredientId?.schema.node).toEqual({
      reference: { entity: "ingredient" },
    });
    expect(row.unknownId?.schema.node).toEqual({ text: { format: null } });
  });

  it("refuses a schema it cannot describe instead of dropping the field", () => {
    expect(() =>
      schemaOf(
        z.object({ when: z.custom<Date>((value) => value instanceof Date) }),
      ),
    ).toThrow(/test.*when/u);
  });
});

describe("declared structured editors", () => {
  it("every field a structured renderer draws has a describable input schema", async () => {
    const structured: string[] = [];
    for (const entity of await loadEntityDeclarations()) {
      for (const field of entity.fieldModel.fields) {
        if (!drawsFromValueSchema(entity.key, field)) continue;
        const schema = field.validation.update ?? field.validation.create;
        if (!schema) throw new Error(`${entity.key}.${field.key} has no input`);
        expect(() =>
          valueSchemaOf(schema, `${entity.key}.${field.key}`, noEntity),
        ).not.toThrow();
        structured.push(`${entity.key}.${field.key}`);
      }
    }
    // Only fields with a read-to-input vector; the rest stay read-only natively.
    expect(structured.sort()).toEqual([
      "financialAccount.sourceAliases",
      "financialTransaction.sourceRefs",
      "product.externalIds",
      "product.labelNutrition",
      "product.unitMappings",
      "recipe.sections",
    ]);
  });

  it("every native-edited field has a read-to-input vector the update schema accepts", async () => {
    const vectors = z
      .object({
        vectors: z.array(
          z.object({
            entity: z.string(),
            field: z.string(),
            read: z.json(),
            input: z.json(),
          }),
        ),
      })
      .parse(
        JSON.parse(
          readFileSync(
            "../../packages/shared/golden-vectors/structured-roundtrip.json",
            "utf8",
          ),
        ),
      ).vectors;
    const covered = new Set(
      vectors.map((vector) => `${vector.entity}.${vector.field}`),
    );
    for (const entity of await loadEntityDeclarations()) {
      for (const field of entity.fieldModel.fields) {
        if (!drawsFromValueSchema(entity.key, field)) continue;
        expect(covered, `${entity.key}.${field.key} needs a vector`).toContain(
          `${entity.key}.${field.key}`,
        );
        const vector = vectors.find(
          (candidate) =>
            candidate.entity === entity.key && candidate.field === field.key,
        );
        const update = field.validation.update;
        expect(update?.safeParse(vector?.input).success).toBe(true);
      }
    }
  });
});

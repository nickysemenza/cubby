import { z } from "zod";

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const action = z.enum([
  "cascade",
  "restrict",
  "no action",
  "set null",
  "set default",
]);
const reference = z
  .object({
    table: name,
    column: name,
    onDelete: action.optional(),
    onUpdate: action.optional(),
  })
  .strict();
const sql = z.string().min(1);

/** Physical child storage only: no shortcode, entity identity or client capability is implied. */
export const childTableMetadataSchema = z
  .object({
    name,
    exportName: name,
    columns: z
      .array(
        z
          .object({
            key: name,
            name: name.optional(),
            kind: z.enum([
              "uuid",
              "text",
              "integer",
              "real",
              "doublePrecision",
              "bigint",
              "boolean",
              "timestamp",
              "date",
              "jsonb",
            ]),
            notNull: z.literal(true).optional(),
            primaryKey: z.literal(true).optional(),
            array: z.literal(true).optional(),
            values: z.array(z.string()).min(1).optional(),
            type: z.string().min(1).optional(),
            default: z
              .union([
                z
                  .union([z.string(), z.number(), z.boolean()])
                  .transform((value) => ({ kind: "literal" as const, value })),
                z
                  .object({ sql })
                  .strict()
                  .transform(({ sql }) => ({ kind: "sql" as const, sql })),
                z
                  .object({ now: z.literal(true) })
                  .strict()
                  .transform(() => ({ kind: "now" as const })),
              ])
              .optional(),
            onUpdateNow: z.literal(true).optional(),
            reference: reference.optional(),
          })
          .strict(),
      )
      .min(1),
    /** Named TypeScript types, used by column `type`; never runtime imports. */
    types: z
      .array(
        z
          .object({ module: z.string().min(1), exports: z.array(name).min(1) })
          .strict(),
      )
      .optional()
      .default([]),
    indexes: z
      .array(
        z
          .object({
            name,
            unique: z.literal(true).optional(),
            using: z.literal("gin").optional(),
            on: z
              .array(
                z.union([
                  name.transform((column) => ({ column, desc: false })),
                  z.object({ column: name, desc: z.literal(true) }).strict(),
                  z.object({ sql }).strict(),
                ]),
              )
              .min(1),
            where: sql.optional(),
          })
          .strict(),
      )
      .optional()
      .default([]),
    checks: z.array(z.object({ name, sql }).strict()).optional().default([]),
    foreignKeys: z
      .array(
        z
          .object({
            name,
            columns: z.array(name).min(1),
            table: name,
            references: z.array(name).min(1),
            onDelete: action.optional(),
            onUpdate: action.optional(),
          })
          .strict(),
      )
      .optional()
      .default([]),
    relations: z
      .array(
        z
          .object({
            name,
            kind: z.enum(["one", "many"]),
            table: name,
            fields: z.array(name).optional(),
            references: z.array(name).optional(),
            relationName: z.string().optional(),
          })
          .strict(),
      )
      .optional()
      .default([]),
  })
  .strict();

export type ChildTableDeclaration = z.input<typeof childTableMetadataSchema>;
export type ChildTableMetadata = z.output<typeof childTableMetadataSchema>;
export const defineChildTable = (
  declaration: ChildTableDeclaration,
): ChildTableDeclaration => declaration;

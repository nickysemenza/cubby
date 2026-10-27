import { z } from "zod";

/** Fixture values enter through the exact public field schema used by the read. */
export function fieldValueFixture<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  if (value === undefined) return missingFieldFixture(schema);
  const result = {
    kind: "live",
    decision: {
      outcome:
        value === null
          ? { kind: "empty", reason: "unset" }
          : { kind: "value", value },
      provenance:
        value === null ? null : { kind: "own", ownership: { kind: "record" } },
    },
  };
  const editable = schema.safeParse({
    current: {
      assignment:
        value === null
          ? { kind: "inherit" }
          : { kind: "value", value, ownership: { kind: "record" } },
      controls: {
        kind: "editable",
        canSetNone: true,
        canConfirm: false,
        reset: { kind: "unavailable" },
      },
    },
    result,
    work: { kind: "idle" },
  });
  return editable.success
    ? editable.data
    : schema.parse({
        current: {
          assignment: null,
          controls: { kind: "readonly", reason: "computed" },
        },
        result: {
          ...result,
          decision: { ...result.decision, provenance: { kind: "computed" } },
        },
        work: { kind: "idle" },
      });
}

function missingFieldFixture<S extends z.ZodType>(schema: S): z.output<S> {
  return schema.parse({
    current: {
      assignment: null,
      controls: { kind: "readonly", reason: "computed" },
    },
    result: { kind: "missing" },
    work: { kind: "idle" },
  });
}

/** Missing fields stay missing; only explicitly provided outcomes are successful. */
export function entityReadFixture<S extends z.ZodObject>(
  schema: S,
  input: unknown,
): z.output<S> {
  const record = z.record(z.string(), z.unknown()).parse(input);
  const declaredFields = schema.shape.fields;
  if (!(declaredFields instanceof z.ZodObject))
    throw new Error("A public read fixture requires canonical fields");
  const fields =
    record.fields === undefined
      ? {}
      : z.record(z.string(), z.unknown()).parse(record.fields);
  return schema.parse({
    ...mock(schema),
    ...record,
    fields: {
      ...Object.fromEntries(
        Object.entries(declaredFields.shape).map(([key, field]) => {
          if (!(field instanceof z.ZodType))
            throw new Error("A fixture field requires a schema");
          return [key, missingFieldFixture(field)];
        }),
      ),
      ...fields,
    },
  });
}

import { mock } from "~/lib/test/mock-schema";

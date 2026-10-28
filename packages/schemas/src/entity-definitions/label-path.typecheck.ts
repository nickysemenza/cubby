import { z } from "zod";

import run from "./23-run.entity.js";
import {
  defineEntity,
  fieldSchemasOf,
  readFieldSchemas,
} from "./definition.js";

const fixture = <const Path extends string>(labelPath: Path) => ({
  ...run,
  model: {
    ...run.model,
    fields: [
      ...run.model.fields,
      {
        key: "fixture" as const,
        kind: "json" as const,
        display: { list: true, labelPath },
        validation: {
          read: z.object({ name: z.string() }),
          create: null,
          update: null,
        },
      },
    ],
  },
});

defineEntity(fixture("fixture.name"), () => []);
// @ts-expect-error A misspelled read-projection path must fail at declaration time.
defineEntity(fixture("vendorAccountLabl"), () => []);
// @ts-expect-error A valid root cannot hide a misspelled nested property.
defineEntity(fixture("fixture.missing"), () => []);

// A broad storage-only spread must not contaminate concrete or union-keyed schemas.
const groupedKeys: readonly ["first", "second"] = ["first", "second"];
const fieldsWithStorage = {
  model: {
    fields: [
      {
        key: "state" as const,
        validation: {
          read: z.enum(["ready", "done"]),
          create: null,
          update: null,
        },
      },
      ...groupedKeys.map((key) => ({
        key,
        validation: {
          read: z.number(),
          create: z.number(),
          update: z.number().optional(),
        },
      })),
      ...["internalKey", "internalSubject"].map((key) => ({
        key,
        output: false,
      })),
    ],
  },
};
const readableFields = readFieldSchemas(fieldsWithStorage);
const readableObject = z.object(readableFields);
const acceptRead = (value: z.output<typeof readableObject>) => value;
acceptRead({ state: "ready", first: 1, second: 2 });
// @ts-expect-error Concrete enum output remains narrow after a storage-only spread.
acceptRead({ state: "unknown", first: 1, second: 2 });
// @ts-expect-error Union field keys remain individually required.
acceptRead({ state: "ready", first: 1 });
const writableFields = fieldSchemasOf(fieldsWithStorage);
const createObject = z.object(writableFields.create);
const acceptCreate = (value: z.output<typeof createObject>) => value;
acceptCreate({ first: 1, second: 2 });
// @ts-expect-error A union-keyed write field cannot disappear from the inferred shape.
acceptCreate({ first: 1 });

import { z } from "zod";

import run from "./23-run.entity.js";
import { defineEntity } from "./definition.js";

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
          read: z.object({
            name: z.string(),
            items: z.array(z.object({ name: z.string().nullable() })),
            tags: z.array(z.string()),
            count: z.number(),
            branded: z.string().brand<"SyntheticLabel">(),
            transformed: z.number().transform(String),
            numericOutput: z.string().transform(Number),
          }),
          create: null,
          update: null,
        },
      },
    ],
    output: [...run.model.output, "fixture" as const],
  },
});

defineEntity(fixture("fixture.name"));
// @ts-expect-error A misspelled read-projection path must fail at declaration time.
defineEntity(fixture("vendorAccountLabl"));
// @ts-expect-error A valid root cannot hide a misspelled nested property.
defineEntity(fixture("fixture.missing"));

// Label paths follow parsed output, including nullable scalars and arrays.
defineEntity(fixture("fixture.items[].name"));
defineEntity(fixture("fixture.items[0].name"));
defineEntity(fixture("fixture.tags[]"));
defineEntity(fixture("fixture.branded"));
defineEntity(fixture("fixture.transformed"));
// @ts-expect-error A numeric output is not a label, even with string input.
defineEntity(fixture("fixture.numericOutput"));
// @ts-expect-error Numeric fields cannot serve as string labels.
defineEntity(fixture("fixture.count"));
// @ts-expect-error An array projection must retain nested-key checking.
defineEntity(fixture("fixture.items[].missing"));

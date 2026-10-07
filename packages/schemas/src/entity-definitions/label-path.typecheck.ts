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
          read: z.object({ name: z.string() }),
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

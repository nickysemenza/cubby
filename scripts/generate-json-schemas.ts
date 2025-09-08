import { configSchema } from "~/schemas/config";

const jsonSchema = z.toJSONSchema(configSchema);

import fs from "fs";
import z from "zod";
fs.writeFileSync(
  "tooling/mapping_schema.json",
  JSON.stringify(jsonSchema, null, 2),
);

console.log("wrote to tooling/mapping_schema.json");

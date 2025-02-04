import { configSchema } from "~/server/config";
import zodToJsonSchema from "zod-to-json-schema";

const jsonSchema = zodToJsonSchema(configSchema, "configuration");

import fs from "fs";
fs.writeFileSync(
  "tooling/mapping_schema.json",
  JSON.stringify(jsonSchema, null, 2),
);

console.log("wrote to tooling/mapping_schema.json");

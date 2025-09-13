import { configSchema } from "~/schemas/config";
import fs from "fs";
import { z } from "zod";

const jsonSchema = z.toJSONSchema(configSchema);

fs.writeFileSync(
  "tooling/mapping_schema.json",
  JSON.stringify(jsonSchema, null, 2),
);

console.log("wrote to tooling/mapping_schema.json");

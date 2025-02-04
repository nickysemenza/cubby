import fs from "fs";
import YAML from "yaml";
import { loadLocations } from "~/server/api/routers/locations";
import { loadProducts } from "~/server/api/routers/products";
import { configSchema } from "~/server/config";
import { db } from "~/server/db";

const file = fs.readFileSync("config.yaml", "utf8");
const parsed = YAML.parse(file) as unknown;
const config = configSchema.parse(parsed);
console.log(config);

await loadLocations(db, config.locations);
await loadProducts(db, config.products);

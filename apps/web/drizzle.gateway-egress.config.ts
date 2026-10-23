import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/server/domains/run/repo/gateway-egress-sql-schema.ts",
  out: "./src/server/domains/run/repo/gateway-egress-migrations",
});

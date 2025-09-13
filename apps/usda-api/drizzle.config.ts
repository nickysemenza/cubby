import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/usda.sqlite",
  },
  verbose: true,
  strict: true,
  tablesFilter: ["!food_search"], // Exclude FTS5 virtual table from migrations
} satisfies Config;
